import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  changePassword,
  deleteAccount,
  newRecoveryCode,
  getUser,
  listTagSuggestions,
  setAcceptsInvitations,
  setFavouriteTag,
  type TagSuggestion,
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
      {profile && user?.id === profile.id && (
        <>
          <FavouriteTagPicker
            initialValue={profile.favouriteTag}
            onChange={(favouriteTag) => setProfile((current) => (current ? { ...current, favouriteTag } : current))}
          />
          <AcceptInvitationsToggle initialValue={profile.acceptsInvitations} />
          <ChangePasswordForm />
          <RecoveryCodeForm />
          <DeleteAccountForm />
        </>
      )}
      <Link to="/">{t('Back to games')}</Link>
    </div>
  );
}

// The same chips-and-field shape as a game's Title & tags editor, minus
// Share: a favourites marker is personal by definition, so there is only
// one thing the button could do.
function FavouriteTagPicker({
  initialValue,
  onChange,
}: {
  initialValue: string | null;
  onChange: (favouriteTag: string | null) => void;
}) {
  const [current, setCurrent] = useState(initialValue);
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The field stays out of the way until asked for, by the + at the end of
  // the list — same as a game's Title & tags editor.
  const [addingTag, setAddingTag] = useState(false);

  useEffect(() => {
    listTagSuggestions()
      .then(({ tags }) => setSuggestions(tags))
      .catch(() => {});
  }, []);

  const choose = (tag: string) => {
    const next = tag.trim();
    if (!next || busy) {
      return;
    }
    setBusy(true);
    setFavouriteTag(next)
      .then(() => {
        setCurrent(next.toLowerCase());
        setDraft('');
        setAddingTag(false);
        onChange(next.toLowerCase());
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="favourite-tag">
      <h3>{t('Favourite tag')}</h3>
      <p className="tag-empty">
        {t('Favourites are one of your own tags. Choose which tag marks them, then tag any game with it.')}
      </p>
      <ul className="tag-suggestions">
        {suggestions.map((suggestion) => {
          const isCurrent = suggestion.tag.toLowerCase() === current;
          return (
            <li key={suggestion.tag}>
              <button
                type="button"
                className={`tag-chip tag-chip--suggestion${isCurrent ? ' tag-chip--current' : ''}`}
                disabled={busy}
                aria-pressed={isCurrent}
                onClick={() => choose(suggestion.tag)}
              >
                {suggestion.tag}
                <span aria-hidden="true">{isCurrent ? '★' : '+'}</span>
              </button>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            className="tag-chip tag-chip--new"
            disabled={busy}
            onClick={() => setAddingTag(true)}
          >
            + {t('New tag')}
          </button>
        </li>
      </ul>
      {addingTag && (
      <form
        className="tag-form"
        onSubmit={(e) => {
          e.preventDefault();
          choose(draft);
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('Add a tag')}
          aria-label={t('Add a tag')}
          maxLength={24}
        />
        <button type="submit" className="modal-action" disabled={busy || !draft.trim()}>
          + {t('Add')}
        </button>
      </form>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

export default Profile;
