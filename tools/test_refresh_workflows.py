"""Guard the effective daily/weekly contracts while sharing implementation steps."""

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
# Full ordered step dictionaries on main 94ec5fc8, excluding shell comments/blank lines.
# This checks more than the artifact allowlist: environments, conditions, timeouts,
# cache keys, EOD2 policies, Tijori work and diagnostic uploads must stay identical.
BASELINES = {
    "daily_refresh.yml": "4f23f0e7b618b07702beee56fe51c49dc1707e7f4336ba646b07db05dce74786",
    "weekly_eod2_refresh.yml": "70b65be786e36af9b8b3c4bb441ba9c3d44729f0ceb636d572113b8f19df4649",
}


def document(path):
    return yaml.safe_load((ROOT / path).read_text())


def normalized(steps):
    result = copy.deepcopy(steps)
    for step in result:
        if 'run' in step:
            step['run'] = '\n'.join(line.rstrip() for line in step['run'].splitlines()
                                    if line.strip() and not line.lstrip().startswith('#'))
    return result


class RefreshWorkflowTests(unittest.TestCase):
    def test_expanded_steps_preserve_both_original_contracts(self):
        for name, expected in BASELINES.items():
            with self.subTest(workflow=name):
                workflow = document('.github/workflows/' + name)
                cron = '30 10 * * 1-5' if name == 'daily_refresh.yml' else '30 3 * * 0'
                # PyYAML YAML 1.1 treats the unquoted GitHub "on" key as True.
                self.assertEqual(workflow.get('on', workflow.get(True)), {
                    'schedule': [{'cron': cron}], 'workflow_dispatch': None,
                })
                self.assertEqual(workflow['concurrency'], {'group': 'daily-data-refresh', 'cancel-in-progress': False})
                self.assertEqual(workflow['permissions'], {'contents': 'write'})
                job, = workflow['jobs'].values()
                expanded = []
                for caller in job['steps']:
                    action_path = caller.get('uses', '')
                    if not action_path.startswith('./.github/actions/'):
                        expanded.append(caller)
                        continue
                    action = document(action_path + '/action.yml')
                    self.assertEqual(action['runs']['using'], 'composite')
                    for source in action['runs']['steps']:
                        step = copy.deepcopy(source)
                        if action_path.endswith('save-refresh-history'):
                            phase = caller['with']['phase']
                            self.assertIn(phase, ('fetch', 'build'))
                            self.assertTrue(caller['continue-on-error'])
                            if step['name'] == 'Validate cache phase':
                                self.assertEqual(step['id'], 'phase')
                                self.assertEqual(step['if'], 'always()')
                                self.assertEqual(step['shell'], 'bash')
                                self.assertEqual(step['env'], {'CACHE_SAVE_PHASE': '${{ inputs.phase }}'})
                                continue
                            condition = "always() && steps.phase.outcome == 'success'"
                            if step['name'] == 'Save prices history':
                                condition += " && inputs.phase == 'fetch'"
                            self.assertEqual(step.pop('if'), condition)
                            if phase == 'build' and step['name'] == 'Save prices history':
                                continue
                            step['if'] = caller['if']
                            step['with']['key'] = step['with']['key'].replace('${{ inputs.phase }}', phase)
                        elif action_path.endswith('commit-refresh-outputs'):
                            self.assertEqual(step.pop('shell'), 'bash')
                            self.assertEqual(step.pop('env'), {
                                'WEEKLY_REFRESH': '${{ inputs.weekly }}',
                                'REFRESH_COMMIT_MESSAGE': '${{ inputs.commit-message }}',
                            })
                            lines, inside = [], False
                            for line in step['run'].splitlines():
                                if line == 'if [ "$WEEKLY_REFRESH" = "true" ]; then':
                                    inside = True
                                elif inside and line == 'fi':
                                    inside = False
                                elif not inside or caller['with']['weekly'] == 'true':
                                    lines.append(line[2:] if inside else line)
                            step['run'] = '\n'.join(lines).replace('$REFRESH_COMMIT_MESSAGE', caller['with']['commit-message'])
                        else:
                            self.assertTrue(action_path.endswith('restore-refresh-history'))
                        expanded.append(step)
                actual = hashlib.sha256(json.dumps(normalized(expanded), sort_keys=True).encode()).hexdigest()
                self.assertEqual(actual, expected, json.dumps(normalized(expanded), indent=2))

    def test_phase_guard_rejects_invalid_inputs_before_cache_writes(self):
        action = document('.github/actions/save-refresh-history/action.yml')
        validation, *saves = action['runs']['steps']
        for step in saves:
            self.assertIn("steps.phase.outcome == 'success'", step['if'])
        for phase in ('fetch', 'build', '', 'fetxh', 'FETCH', 'fetch; false'):
            with self.subTest(phase=phase):
                result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', validation['run']],
                                        env=dict(os.environ, CACHE_SAVE_PHASE=phase),
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0 if phase in ('fetch', 'build') else 1)
                if result.returncode:
                    self.assertIn('::error::Cache phase must be fetch or build', result.stdout)

    def test_commit_shell_preserves_allowlist_without_running_git(self):
        step, = document('.github/actions/commit-refresh-outputs/action.yml')['runs']['steps']
        subprocess.run(['bash', '-n'], input=step['run'], text=True, check=True)
        fake_git = "git() { printf '%s\\0' \"$@\"; printf '\\n'; };\n"
        for weekly, additions in [('false', 30), ('true', 32)]:
            with self.subTest(weekly=weekly):
                message = 'literal $(false) commit message'
                env = dict(os.environ, WEEKLY_REFRESH=weekly, REFRESH_COMMIT_MESSAGE=message)
                result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', fake_git + step['run']],
                                        env=env, capture_output=True, text=True, check=True)
                calls = [line.rstrip('\0').split('\0') for line in result.stdout.splitlines()]
                self.assertEqual(sum(call[0] == 'add' for call in calls), additions)
                self.assertIn(['reset', '--mixed', 'origin/main'], calls)
                self.assertIn(['commit', '-m', message], calls)
                self.assertEqual(calls[-1], ['push'])


if __name__ == '__main__':
    unittest.main()
