import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { listReports, markReportHandled, type Report } from '../services/api';

// Deliberately not translated, for the same reason as the performance
// screen: the server answers 403 to everybody but the one account named
// by ADMIN_USERNAME, so nine translations of "Reporter" would be nine
// strings to keep in step for an audience of one.
//
// Unlinked, too — there is no nav entry for it anywhere. Whoever needs it
// knows the address, or arrives from the push notification that announced
// the report.
//
// Cards rather than a table: a report is a handful of short fields and one
// long one, and a row of those on a phone is either a horizontal scroll or
// a column of slivers. The card stacks, so the only thing a narrow screen
// changes is how much of the note is visible.

const REASONS: Record<string, string> = {
  username: 'Offensive name',
  game_text: 'Offensive text in a game',
  behaviour: 'Behaviour',
};

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function useReports() {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listReports()
      .then(setReports)
      .catch((err: Error) => setError(err.message));
  }, []);

  return { reports, setReports, error, setError };
}

function Reports() {
  const { reports, error } = useReports();

  if (error) {
    return (
      <div className="reports-page">
        <h2>{'Reports'}</h2>
        <p className="error">{error}</p>
        <Link to="/">{'Back to games'}</Link>
      </div>
    );
  }

  if (!reports) {
    return <div className="reports-page">{'Loading…'}</div>;
  }

  const open = reports.filter((report) => report.handled_at === null);
  const handled = reports.length - open.length;

  return (
    <div className="reports-page">
      <h2>{'Reports'}</h2>
      <p className="muted">
        {reports.length === 0
          ? 'Nothing reported yet.'
          : open.length === 0
            ? `Nothing to deal with. ${handled} dealt with so far.`
            : `${open.length} to deal with${handled > 0 ? `, ${handled} already done` : ''}.`}
      </p>

      <ul className="report-cards">
        {open.map((report) => (
          <li key={report.id}>
            {/* The whole card is the link, so the tap target is the card
                rather than a word in it. Nothing else in here is
                interactive — Done lives on the report's own page, where
                you have read the thing you are signing off. */}
            <Link to={`/reports/${report.id}`} className="report-card">
              <span className="report-card-head">
                <strong>{report.target}</strong>
                <span className="report-card-reason">{REASONS[report.reason] ?? report.reason}</span>
              </span>
              {report.note && <span className="report-card-note">{report.note}</span>}
              <span className="report-card-meta">
                {`from ${report.reporter} · ${formatWhen(report.created_at)}`}
                {report.game_id ? ' · has a game' : ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <p>
        <Link to="/">{'Back to games'}</Link>
      </p>
    </div>
  );
}

// One report in full, and the one action there is to take on it.
export function ReportDetails() {
  const { id } = useParams<{ id: string }>();
  const { reports, setReports, error, setError } = useReports();
  const [busy, setBusy] = useState(false);

  const report = reports?.find((each) => each.id === id);

  const markHandled = () => {
    if (!report) {
      return;
    }
    setBusy(true);
    setError(null);
    markReportHandled(report.id)
      .then(() =>
        setReports((current) =>
          (current ?? []).map((each) => (each.id === report.id ? { ...each, handled_at: Date.now() } : each)),
        ),
      )
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="reports-page">
      <h2>{'Report'}</h2>
      {error && <p className="error">{error}</p>}
      {!reports && !error && <p>{'Loading…'}</p>}
      {reports && !report && <p className="muted">{'No such report.'}</p>}

      {report && (
        <>
          <dl className="report-fields">
            <dt>{'About'}</dt>
            <dd>
              <Link to={`/profile/${report.target_id}`}>{report.target}</Link>
            </dd>
            <dt>{'Reason'}</dt>
            <dd>{REASONS[report.reason] ?? report.reason}</dd>
            <dt>{'From'}</dt>
            <dd>
              <Link to={`/profile/${report.reporter_id}`}>{report.reporter}</Link>
            </dd>
            <dt>{'When'}</dt>
            <dd>{formatWhen(report.created_at)}</dd>
            {report.game_id && (
              <>
                <dt>{'Game'}</dt>
                <dd>
                  <Link to={`/games/${report.game_id}`}>{'open the game'}</Link>
                </dd>
              </>
            )}
            <dt>{'Status'}</dt>
            <dd>{report.handled_at === null ? 'not yet dealt with' : `dealt with ${formatWhen(report.handled_at)}`}</dd>
          </dl>

          {/* Shown as typed — it is the evidence, and tidying it here
              would hide what is being complained about. React escapes it. */}
          {report.note && <p className="report-note">{report.note}</p>}

          {report.handled_at === null && (
            <p>
              <button type="button" onClick={markHandled} disabled={busy}>
                {'Done'}
              </button>
            </p>
          )}
        </>
      )}

      <p>
        <Link to="/reports">{'Back to reports'}</Link>
      </p>
    </div>
  );
}

export default Reports;
