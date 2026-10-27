"""Guard the effective daily/weekly contracts while sharing implementation steps."""

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest
import unittest.mock

import yaml


ROOT = Path(__file__).resolve().parents[1]
# Full ordered steps, including backup policy, EOD2 caching and daily session registration.
# This checks more than the artifact allowlist: environments, conditions, timeouts,
# cache keys, EOD2 policies, Tijori work and diagnostic uploads must stay identical.
BASELINES = {
    "daily_refresh.yml": "1b4cb15b9daccca3f572d1e5048ad39f69da167e003ea26c5e3766ddf9768a91",
    "weekly_eod2_refresh.yml": "d727ca44362c6bc814816c9c0d0467b3f629d1aadd10348ca128b92201fcddb0",
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
        for name, expected in [('daily_refresh.yml', "${{ github.event_name == 'schedule' && '0' || '1' }}"),
                               ('weekly_eod2_refresh.yml', '1')]:
            job, = document('.github/workflows/' + name)['jobs'].values()
            build, = [step for step in job['steps'] if step['name'] == 'Build and publish validated data']
            self.assertEqual(build['env']['EDL_FILING_BACKUPS'], expected)

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

    def test_dhan_refresh_is_bounded_and_preserves_the_main_refresh_on_failure(self):
        job, = document('.github/workflows/weekly_eod2_refresh.yml')['jobs'].values()
        step, = [s for s in job['steps'] if s.get('id') == 'dhan_group_sync']
        self.assertTrue(step['continue-on-error'])
        self.assertEqual(step['timeout-minutes'], 10)
        self.assertEqual(step['run'].strip(), 'python3 "DO NOT DELETE EDL PIPELINE/sync_dhan_group_stocks.py"')

    def test_eod2_cache_saves_only_successful_changed_checkouts(self):
        fake_git = '''git() {
          if [ "$1" = "clone" ] || [ "$3" = "pull" ]; then
            [ "$UPDATE_EXIT" = "0" ] || return "$UPDATE_EXIT"
            mkdir -p "$EOD2_DATA_DIR/.git"
            touch "$EOD2_DATA_DIR/updated"
          elif [ "$3" = "rev-parse" ]; then
            if [ -f "$EOD2_DATA_DIR/updated" ]; then echo "$NEXT";
            elif [ -n "$PREVIOUS" ]; then echo "$PREVIOUS";
            else return 1; fi
          else return 1; fi
        };
        '''
        import tempfile
        for name in BASELINES:
            job, = document('.github/workflows/' + name)['jobs'].values()
            steps = {step['name']: step for step in job['steps']}
            restore = steps['Restore EOD2 data checkout']
            update = steps['Update EOD2 adjusted-history data']
            save = steps['Save updated EOD2 data checkout']
            self.assertEqual(restore['uses'], 'actions/cache/restore@v4')
            self.assertEqual(restore['with']['restore-keys'].splitlines(),
                             ['eod2-data-v2-${{ runner.os }}-', 'eod2-data-v1-${{ runner.os }}-'])
            self.assertEqual(save['uses'], 'actions/cache/save@v4')
            self.assertEqual(save['if'], "steps.eod2-update.outcome == 'success' && steps.eod2-update.outputs.changed == 'true'")
            self.assertTrue(save['continue-on-error'])
            self.assertEqual(save['with']['key'], 'eod2-data-v2-${{ runner.os }}-${{ steps.eod2-update.outputs.revision }}')
            self.assertEqual(save['with']['path'], restore['with']['path'])
            self.assertEqual(update['id'], 'eod2-update')
            for previous, next_revision, exit_code in [('old', 'new', 0), ('same', 'same', 0), ('', 'new', 0), ('old', 'new', 3)]:
                with self.subTest(workflow=name, previous=previous, exit_code=exit_code), tempfile.TemporaryDirectory() as folder:
                    checkout = Path(folder) / 'checkout'
                    if previous:
                        (checkout / '.git').mkdir(parents=True)
                    output = Path(folder) / 'output'
                    env = dict(os.environ, EOD2_DATA_DIR=str(checkout), GITHUB_OUTPUT=str(output),
                               PREVIOUS=previous, NEXT=next_revision, UPDATE_EXIT=str(exit_code))
                    result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', fake_git + update['run']],
                                            env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, exit_code)
                    values = output.read_text() if output.exists() else ''
                    self.assertEqual(values, '' if exit_code else f'revision={next_revision}\n' +
                                     ('changed=true\n' if previous != next_revision else ''))

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
        # The Earnings Pulse and Heatmap indexes are staged only once they exist in the checkout.
        optional = (
            int((ROOT / 'frontend/public/data/results/index.json').is_file())
            + int((ROOT / 'frontend/public/data/results/us_index.json').is_file())
            + int((ROOT / 'frontend/public/data/heatmap/index.json').is_file())
        )
        for weekly, additions in [('false', 3 + optional), ('true', 6 + optional)]:
            with self.subTest(weekly=weekly):
                message = 'literal $(false) commit message'
                env = dict(os.environ, WEEKLY_REFRESH=weekly, REFRESH_COMMIT_MESSAGE=message)
                result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', fake_git + step['run']],
                                        env=env, capture_output=True, text=True, check=True)
                calls = [line.rstrip('\0').split('\0') for line in result.stdout.splitlines()]
                self.assertEqual(sum(call[0] == 'add' for call in calls), additions)
                self.assertEqual(['add', 'reference/dhan/group-stocks.json'] in calls, weekly == 'true')
                self.assertTrue(any(call[0] == 'add' and 'frontend/public/data/price-band-history.json' in call for call in calls))
                self.assertIn(['reset', '--mixed', 'origin/main'], calls)
                self.assertIn(['commit', '-m', message], calls)
                self.assertEqual(calls[-1], ['push'])
                # Carried-over pipeline files go to R2 (tools/pipeline_state.py), never into Git history.
                staged = {path for call in calls if call[0] == 'add' for path in call[1:]}
                self.assertFalse(any(path.startswith('DO NOT DELETE EDL PIPELINE/') for path in staged))

    def test_pipeline_state_is_pulled_before_fetch_and_pushed_after_a_successful_build(self):
        for name in ('daily_refresh.yml', 'weekly_eod2_refresh.yml'):
            with self.subTest(workflow=name):
                job, = document('.github/workflows/' + name)['jobs'].values()
                names = [step['name'] for step in job['steps']]
                pull, push = names.index('Pull pipeline state from R2'), names.index('Push pipeline state to R2')
                self.assertLess(names.index('Install R2 uploader'), pull)
                self.assertLess(pull, names.index('Fetch refresh inputs'))
                self.assertLess(names.index('Build and publish validated data'), push)
                self.assertLess(push, names.index('Commit and Push Results'))
                step = job['steps'][push]
                # Default success(): a failed build never pushes, and a failed push stops the commit.
                self.assertNotIn('if', step)
                self.assertNotIn('continue-on-error', step)
        job, = document('.github/workflows/backfill_historical_snapshots.yml')['jobs'].values()
        names = [step['name'] for step in job['steps']]
        self.assertLess(names.index('Pull pipeline state from R2'), names.index('Generate Historical Snapshots'))
        self.assertNotIn('Push pipeline state to R2', names)
        upload = next(step for step in job['steps'] if step['name'] == 'Upload to Cloudflare R2')['run']
        # Same object metadata as the daily archive (frontend/session_history.py).
        self.assertIn("ExtraArgs={'ContentType': 'application/gzip'}", upload)
        self.assertNotIn('ContentEncoding', upload)

    def test_backfill_upload_is_a_successful_no_op_when_every_date_is_archived(self):
        import sys, tempfile, types
        job, = document('.github/workflows/backfill_historical_snapshots.yml')['jobs'].values()
        run = next(step for step in job['steps'] if step['name'] == 'Upload to Cloudflare R2')['run']
        script = run.split("<< 'EOF'\n", 1)[1].rsplit('\nEOF', 1)[0]
        env = {'R2_ACCOUNT_ID': 'a', 'R2_ACCESS_KEY_ID': 'b', 'R2_SECRET_ACCESS_KEY': 'c'}
        with tempfile.TemporaryDirectory() as folder:
            previous = Path.cwd()
            os.chdir(folder)
            try:
                with unittest.mock.patch.dict(sys.modules, {'boto3': types.SimpleNamespace(client=lambda *a, **k: None)}), \
                        unittest.mock.patch.dict(os.environ, env), self.assertRaises(SystemExit) as exit:
                    exec(compile(script, 'upload', 'exec'), {'__name__': '__main__'})
            finally:
                os.chdir(previous)
            self.assertEqual(exit.exception.code, 0)
            # No sentinel, so 'Commit Updated Sessions Manifest' is skipped.
            self.assertFalse((Path(folder)/'.upload_verified').exists())


if __name__ == '__main__':
    unittest.main()
