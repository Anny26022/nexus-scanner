const workflow = 'https://api.github.com/repos/Anny26022/nexus-scanner/actions/workflows/daily_refresh.yml';

// Most recent 4 PM IST slot, including a GitHub fallback delivered after midnight.
export function refreshCutoff(time) {
  return new Date(time - 10.5 * 60 * 60 * 1000).toISOString().slice(0,10) + 'T10:30:00Z';
}

export function existingRefresh(runs, cutoff, currentId = Infinity) {
  return runs.find(run => run.id < currentId && run.head_branch === 'main'
    && run.created_at >= cutoff && (run.status !== 'completed' || run.conclusion === 'success'));
}

export async function triggerRefresh(time, token, request = fetch) {
  if (!token) throw new Error('Configure the GITHUB_TOKEN Worker secret before enabling the scheduler');
  const cutoff = refreshCutoff(time);
  const headers = {'Authorization':`Bearer ${token}`, 'Accept':'application/vnd.github+json',
    'User-Agent':'nexus-refresh-scheduler', 'X-GitHub-Api-Version':'2022-11-28'};
  const response = await request(`${workflow}/runs?branch=main&per_page=100&created=${encodeURIComponent('>=' + cutoff)}`,
    {headers, signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`GitHub run lookup failed (HTTP ${response.status})`);
  const data = await response.json();
  if (!Array.isArray(data.workflow_runs) || data.total_count > 100) throw new Error('Incomplete GitHub run lookup');
  const existing = existingRefresh(data.workflow_runs, cutoff);
  if (existing) return {action:'skipped', runId:existing.id, cutoff};
  const dispatch = await request(`${workflow}/dispatches`, {method:'POST', headers:{...headers,'Content-Type':'application/json'},
    body:JSON.stringify({ref:'main',inputs:{scheduled_refresh:'true'}}), signal:AbortSignal.timeout(15000)});
  if (!dispatch.ok) throw new Error(`GitHub dispatch failed (HTTP ${dispatch.status})`);
  return {action:'dispatched', cutoff};
}

export default {
  async scheduled(controller, env) {
    console.log(JSON.stringify(await triggerRefresh(controller.scheduledTime, env.GITHUB_TOKEN)));
  },
};
