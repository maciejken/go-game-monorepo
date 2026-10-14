import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listReports, type Report } from '../services/api';

// Deliberately not translated, for the same reason as the performance
// screen: the server answers 403 to everybody but the one account named
// by ADMIN_USERNAME, so nine translations of "Reporter" would be nine
// strings to keep in step for an audience of one.
//
// Unlinked, too — there is no nav entry for it anywhere. Whoever needs it
// knows the address, and a link would only advertise a page that almost
// nobody can open.

const REASONS: Record<string, string> = {
  username: 'Offensive name',
  game_text: 'Offensive text in a game',
  behaviour: 'Behaviour',
};

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function Reports() {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listReports()
      .then(setReports)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) {
    return (
      <div className="perf-page">
        <h2>{'Reports'}</h2>
        <p className="error">{error}</p>
        <Link to="/">{'Back to games'}</Link>
      </div>
    );
  }

  if (!reports) {
    return <div className="perf-page">{'Loading…'}</div>;
  }

  const open = reports.filter((report) => report.handled_at === null).length;

  return (
    <div className="perf-page">
      <h2>{'Reports'}</h2>
      <p className="muted">
        {reports.length === 0
          ? 'Nothing reported yet.'
          : `${reports.length} in all, ${open} not yet dealt with.`}
      </p>

      {reports.length > 0 && (
        <table className="perf-table reports-table">
          <thead>
            <tr>
              <th>{'When'}</th>
              <th>{'About'}</th>
              <th>{'From'}</th>
              <th>{'Reason'}</th>
              <th>{'Note'}</th>
              <th>{'Game'}</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((report) => (
              <tr key={report.id} className={report.handled_at === null ? undefined : 'reports-handled'}>
                <td>{formatWhen(report.created_at)}</td>
                <td>{report.target}</td>
                <td>{report.reporter}</td>
                <td>{REASONS[report.reason] ?? report.reason}</td>
                {/* Whatever the reporter typed, shown as typed — it is
                    the evidence, and sanitising it here would hide what
                    is being complained about. React escapes it. */}
                <td className="reports-note">{report.note ?? '—'}</td>
                <td>{report.game_id ? <Link to={`/games/${report.game_id}`}>{'open'}</Link> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p>
        <Link to="/">{'Back to games'}</Link>
      </p>
    </div>
  );
}

export default Reports;
