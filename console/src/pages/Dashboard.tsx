import { useStatus, useChannels, useDoctor } from '../api/hooks';
import Card from '../components/shared/Card';
import Badge from '../components/shared/Badge';
import Skeleton from '../components/shared/Skeleton';

export default function Dashboard() {
  const { data: status, isLoading } = useStatus();
  const { data: doctor } = useDoctor();
  const { data: channels } = useChannels();

  if (isLoading) return <Skeleton rows={6} className="max-w-2xl" />;
  if (!status) return <p className="text-zinc-400">Failed to load status</p>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Dashboard</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Card
          title="Ollama"
          value={status.ollama.available ? 'Online' : 'Offline'}
          subtitle={`${status.ollama.models} models loaded`}
        />
        <Card title="Tools" value={status.tools} subtitle="registered" />
        <Card
          title="Cron"
          value={status.cron.jobs + status.cron.heartbeats}
          subtitle={`${status.cron.jobs} cron + ${status.cron.heartbeats} heartbeat`}
        />
        <Card title="Memory" value={status.memory.totalFacts} subtitle="facts stored" />
      </div>

      <h3 className="text-lg font-semibold mb-3">Doctor</h3>
      <div className="mb-8 bg-zinc-900 border border-zinc-800 rounded-lg divide-y divide-zinc-800">
        {!doctor && <div className="p-4 text-sm text-zinc-400">Checking the machine against your config…</div>}
        {doctor && (
          <div className="p-3 text-xs text-zinc-400">{doctor.passes} pass · {doctor.warns} warn · {doctor.fails} fail · {doctor.platform}</div>
        )}
        {doctor?.checks.filter(c => c.status !== 'PASS').map(c => (
          <div key={c.name} className="p-3 flex gap-3 items-start">
            <Badge label={c.status} />
            <div className="min-w-0">
              <div className="text-sm font-medium">{c.name}{c.detail ? <span className="text-zinc-400 font-normal"> — {c.detail}</span> : null}</div>
              {c.fix && <div className="text-xs text-zinc-500 mt-1 font-mono break-words">{c.fix}</div>}
            </div>
          </div>
        ))}
        {doctor && doctor.checks.every(c => c.status === 'PASS') && <div className="p-4 text-sm text-emerald-400">Everything your config enables is present.</div>}
      </div>

      <h3 className="text-lg font-semibold mb-3">Channels</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {channels?.map(ch => (
          <div key={ch.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex items-center justify-between">
            <span className="text-sm font-medium capitalize">{ch.id}</span>
            <Badge label={ch.status} />
          </div>
        ))}
      </div>
    </div>
  );
}
