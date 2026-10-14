import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  blockUser,
  changePassword,
  deleteAccount,
  listBlockedUsers,
  newRecoveryCode,
  getUser,
  reportUser,
  setAcceptsInvitations,
  unblockUser,
  type ReportReason,
  type UserProfile,
} from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { t } from '../i18n';

function formatJoinDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { dateStyle: 'long' });
}

// Only ever shown on your own profile (gated in Profile below) — viewing
// someone else's profile has no reason to expose this.
function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (newPassword !== confirmPassword) {
      setError(t('New passwords do not match'));
      return;
    }
    setSubmitting(true);
    changePassword(currentPassword, newPassword)
      .then(() => {
        setSuccess(true);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSubmitting(false));
  };

  return (
    <>
      <h3>{t('Change password')}</h3>
      <form className="auth-form" onSubmit={submit}>
        <label>
          {t('Current password')}
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          {t('New password')}
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            minLength={6}
            maxLength={128}
            required
          />
        </label>
        <label>
          {t('Confirm new password')}
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        {success && <p className="success">{t('Password changed.')}</p>}
        <button type="submit" disabled={submitting}>
          {t('Change password')}
        </button>
      </form>
    </>
  );
}

// Only ever shown on your own profile (gated in Profile below) — an
// optimistic checkbox: flips immediately, then reverts with an error
// message if the request fails, mirroring the star-toggle pattern used
// elsewhere in this app for a single-field, no-confirmation-needed setting.
function AcceptInvitationsToggle({ initialValue }: { initialValue: boolean }) {
  const [checked, setChecked] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

  const toggle = (next: boolean) => {
    setChecked(next);
    setError(null);
    setAcceptsInvitations(next).catch((err: Error) => {
      setChecked(!next);
      setError(err.message);
    });
  };

  return (
    <p>
      <label>
        <input type="checkbox" checked={checked} onChange={(e) => toggle(e.target.checked)} /> Accept invitations
      </label>
      {error && <span className="error"> {error}</span>}
    </p>
  );
}

// A code for an account that has none, or has spent the one it had. The
// password is required, because this hands out a key to the account.
function RecoveryCodeForm() {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    newRecoveryCode(password)
      .then((issued) => {
        setCode(issued);
        setPassword('');
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSubmitting(false));
  };

  return (
    <>
      <h3>{t('Recovery code')}</h3>
      <p className="muted">
        {t("A code that sets a new password when you've forgotten yours. A new one replaces the last.")}
      </p>
      {code ? (
        <>
          <p className="recovery-code">{code}</p>
          <p className="muted">
            {t(
              "Write this down. It is the only way back into your account if you forget your password, and it isn't shown again.",
            )}
          </p>
        </>
      ) : (
        <form className="auth-form" onSubmit={submit}>
          <label>
            {t('Current password')}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={submitting || password.length === 0}>
            {t('Get a new recovery code')}
          </button>
        </form>
      )}
    </>
  );
}

// Last on the page, and honest about what it leaves behind. Typing the
// password again is the confirmation — a "sure?" button is easy to press
// by accident, and the server asks for it regardless.
function DeleteAccountForm() {
  const { logout } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    deleteAccount(password)
      // The session went with the account; this catches the page up.
      .then(() => logout())
      .catch((err: Error) => setError(err.message))
      .finally(() => setSubmitting(false));
  };

  return (
    <>
      <h3>{t('Delete account')}</h3>
      <p className="muted">
        {t(
          'This cannot be undone. Your account and the games you played alone are deleted; games against other players stay with them, without your name.',
        )}
      </p>
      <form className="auth-form" onSubmit={submit}>
        <label>
          {t('Current password')}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="danger" disabled={submitting || password.length === 0}>
          {t('Delete account')}
        </button>
      </form>
    </>
  );
}


// Somebody else's profile: the one thing you can do to them, phrased as a
// toggle of a state you can see, so it is obvious which way round it is
// before you press anything.
function BlockButton({ profile, onChange }: { profile: UserProfile; onChange: (blocked: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    setBusy(true);
    setError(null);
    const next = !profile.blocked;
    (next ? blockUser(profile.username) : unblockUser(profile.username))
      .then(() => onChange(next))
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <p className="muted">
        {profile.blocked
          ? t("They can't invite you to games. They aren't told.")
          : t("Blocking stops them inviting you to games. They aren't told.")}
      </p>
      <p>
        <button type="button" className={profile.blocked ? undefined : 'danger'} onClick={toggle} disabled={busy}>
          {profile.blocked ? t('Unblock') : t('Block')}
        </button>
      </p>
      {error && <p className="error">{error}</p>}
    </>
  );
}

// Reporting is not blocking: blocking is a decision about your own games,
// a report asks somebody to look at a name or something written on a
// game. Both are offered, and the block is suggested alongside, because
// whoever wants one usually wants the other.
function ReportForm({ username, onBlocked }: { username: string; onBlocked: () => void }) {
  const [reason, setReason] = useState<ReportReason>('behaviour');
  const [note, setNote] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(true);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    reportUser({ username, reason, note, block: alsoBlock })
      .then(() => {
        setSent(true);
        if (alsoBlock) {
          onBlocked();
        }
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSubmitting(false));
  };

  if (sent) {
    return (
      <>
        <h3>{t('Report')}</h3>
        <p className="success">{t("Thanks — we'll look at this within a day.")}</p>
      </>
    );
  }

  return (
    <>
      <h3>{t('Report')}</h3>
      <form className="auth-form" onSubmit={submit}>
        <fieldset>
          <legend>{t('Reason')}</legend>
          {(
            [
              ['username', t('Offensive name')],
              ['game_text', t('Offensive text in a game')],
              ['behaviour', t('Behaviour towards me')],
            ] as [ReportReason, string][]
          ).map(([value, label]) => (
            <label className="inline" key={value}>
              <input
                type="radio"
                name="report-reason"
                value={value}
                checked={reason === value}
                onChange={() => setReason(value)}
              />{' '}
              {label}
            </label>
          ))}
        </fieldset>
        <label>
          {t('Anything else we should know?')}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} />
        </label>
        <label className="inline">
          <input type="checkbox" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} />{' '}
          {t('Block them too')}
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={submitting}>
          {t('Send')}
        </button>
      </form>
    </>
  );
}

// Your own profile: everyone you have blocked, and the only thing to do
// with the list — undo one. There is no way to add somebody here, which
// is the point: blocking starts from the person, not from a list.
function BlockedUsers() {
  const [names, setNames] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listBlockedUsers()
      .then(setNames)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (!names || names.length === 0) {
    return null;
  }

  const unblock = (name: string) => {
    setBusy(name);
    setError(null);
    unblockUser(name)
      .then(() => setNames((current) => (current ?? []).filter((each) => each !== name)))
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(null));
  };

  return (
    <>
      <h3>{t('Blocked players')}</h3>
      <p className="muted">{t("They can't invite you, and don't know it. Tap a name to let them again.")}</p>
      <ul className="tag-chips">
        {names.map((name) => (
          <li className="tag-chip" key={name}>
            {name}
            <button type="button" onClick={() => unblock(name)} disabled={busy === name} aria-label={t('Unblock')}>
              ×
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </>
  );
}

// Keyed by id so moving between profiles mounts a fresh ProfileView — its
// state starts empty instead of showing the previous user until the new
// one loads, and a late response for the old id lands on the unmounted one.
function Profile() {
  const { id } = useParams<{ id: string }>();
  return <ProfileView key={id} id={id} />;
}

function ProfileView({ id }: { id: string | undefined }) {
  const { user } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      return;
    }
    getUser(id)
      .then(setProfile)
      .catch((err: Error) => setError(err.message));
  }, [id]);

  return (
    <div className="auth-wrap">
      <h2>{t('Profile')}</h2>
      {error && <p className="error">{error}</p>}
      {profile && (
        <dl className="profile-fields">
          <dt>{t('Username')}</dt>
          <dd>{profile.username}</dd>
          <dt>{t('Joined')}</dt>
          <dd>{formatJoinDate(profile.createdAt)}</dd>
          <dt>{t('Games played')}</dt>
          <dd>{profile.gamesPlayed}</dd>
          <dt>{t('Won')}</dt>
          <dd>{profile.gamesWon}</dd>
          <dt>{t('Lost')}</dt>
          <dd>{profile.gamesLost}</dd>
        </dl>
      )}
      {/* Neither offered for GNU Go: the server named that account, it
          writes nothing, and blocking a computer opponent that never
          invites anybody would do nothing at all. */}
      {profile && user && user.id !== profile.id && !profile.isAi && (
        <>
          <BlockButton
            profile={profile}
            onChange={(blocked) => setProfile((current) => (current ? { ...current, blocked } : current))}
          />
          <ReportForm
            username={profile.username}
            onBlocked={() => setProfile((current) => (current ? { ...current, blocked: true } : current))}
          />
        </>
      )}
      {profile && user?.id === profile.id && (
        <>
          <AcceptInvitationsToggle initialValue={profile.acceptsInvitations} />
          <BlockedUsers />
          <ChangePasswordForm />
          <RecoveryCodeForm />
          <DeleteAccountForm />
        </>
      )}
      <Link to="/">{t('Back to games')}</Link>
    </div>
  );
}


export default Profile;
