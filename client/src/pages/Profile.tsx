import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { changePassword, getUser, setAcceptsInvitations, type UserProfile } from '../services/api';
import { useAuth } from '../hooks/useAuth';

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
      setError('New passwords do not match');
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
      <h3>Change password</h3>
      <form className="auth-form" onSubmit={submit}>
        <label>
          Current password
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          New password
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
          Confirm new password
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        {success && <p className="success">Password changed.</p>}
        <button type="submit" disabled={submitting}>
          Change password
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

function Profile() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      return;
    }
    setProfile(null);
    setError(null);
    getUser(id)
      .then(setProfile)
      .catch((err: Error) => setError(err.message));
  }, [id]);

  return (
    <div className="auth-wrap">
      <h2>Profile</h2>
      {error && <p className="error">{error}</p>}
      {profile && (
        <dl className="profile-fields">
          <dt>Username</dt>
          <dd>{profile.username}</dd>
          <dt>Joined</dt>
          <dd>{formatJoinDate(profile.createdAt)}</dd>
          <dt>Games played</dt>
          <dd>{profile.gamesPlayed}</dd>
          <dt>Won</dt>
          <dd>{profile.gamesWon}</dd>
          <dt>Lost</dt>
          <dd>{profile.gamesLost}</dd>
        </dl>
      )}
      {profile && user?.id === profile.id && (
        <>
          <AcceptInvitationsToggle initialValue={profile.acceptsInvitations} />
          <ChangePasswordForm />
        </>
      )}
      <Link to="/">Back to games</Link>
    </div>
  );
}

export default Profile;
