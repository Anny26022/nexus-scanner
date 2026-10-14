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
# Full ordered step dictionaries, including the intentional weekly/manual backup policy.
# This checks more than the artifact allowlist: environments, conditions, timeouts,
# cache keys, EOD2 policies, Tijori work and diagnostic uploads must stay identical.
BASELINES = {
    "daily_refresh.yml": "b0280037677f31d9808f0242c2a65fd6714fa4e056cba251fa360b62fdf7b693",
    "weekly_eod2_refresh.yml": "41a512552a6b00da1c730adb5f7ec2cb3073b064b440e9de087d903d52ee6128",
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
    def test_backup_policy_preserves_manual_runs_and_weekly_archives(self):
        for name, expected in [('daily_refresh.yml', "${{ (github.event_name == 'schedule' || inputs.scheduled_refresh) && '0' || '1' }}"),
                               ('weekly_eod2_refresh.yml', '1')]:
            job = document('.github/workflows/' + name)['jobs']['refresh-data' if name == 'daily_refresh.yml' else 'refresh-adjusted-history']
            build, = [step for step in job['steps'] if step['name'] == 'Build and publish validated data']
            self.assertEqual(build['env']['EDL_FILING_BACKUPS'], expected)

    def test_expanded_steps_preserve_both_original_contracts(self):
        for name, expected in BASELINES.items():
            with self.subTest(workflow=name):
                workflow = document('.github/workflows/' + name)
                cron = '30 10 * * 1-5' if name == 'daily_refresh.yml' else '30 3 * * 0'
                # PyYAML YAML 1.1 treats the unquoted GitHub "on" key as True.
                dispatch = {'inputs': {'scheduled_refresh': {'description': 'Automatic daily trigger (Cloudflare scheduler)',
                            'type': 'boolean', 'default': False}}} if name == 'daily_refresh.yml' else None
                self.assertEqual(workflow.get('on', workflow.get(True)), {
                    'schedule': [{'cron': cron}], 'workflow_dispatch': dispatch,
                })
                self.assertEqual(workflow['concurrency'], {'group': 'daily-data-refresh', 'cancel-in-progress': False})
                permissions = {'contents': 'write', 'actions': 'read'} if name == 'daily_refresh.yml' else {'contents': 'write'}
                self.assertEqual(workflow['permissions'], permissions)
                job = workflow['jobs']['refresh-data' if name == 'daily_refresh.yml' else 'refresh-adjusted-history']
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
                # The external automatic dispatch keeps the scheduled archive policy;
                # manual runs still request full backups. All other pipeline steps
                # retain the original contract.
                if name == 'daily_refresh.yml':
                    for step in expanded:
                        if step['name'] == 'Build and publish validated data':
                            step['env']['EDL_FILING_BACKUPS'] = "${{ github.event_name == 'schedule' && '0' || '1' }}"
                actual = hashlib.sha256(json.dumps(normalized(expanded), sort_keys=True).encode()).hexdigest()
                self.assertEqual(actual, expected, json.dumps(normalized(expanded), indent=2))

    def test_daily_refresh_checks_for_duplicates_before_starting_the_pipeline(self):
        jobs = document('.github/workflows/daily_refresh.yml')['jobs']
        self.assertEqual(jobs['refresh-data']['needs'], 'refresh-gate')
        self.assertEqual(jobs['refresh-data']['if'], "needs.refresh-gate.outputs.should_run == 'true'")
        gate = jobs['refresh-gate']['steps'][1]
        self.assertIn('existingRefresh(data.workflow_runs, cutoff, context.runId)', gate['with']['script'])
        self.assertEqual(gate['env']['AUTOMATIC_REFRESH'], "${{ github.event_name == 'schedule' || inputs.scheduled_refresh }}")

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
