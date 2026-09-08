import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getUser, type UserProfile } from '../services/api';

function formatJoinDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { dateStyle: 'long' });
}

function Profile() {
  const { id } = useParams<{ id: string }>();
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
        </dl>
      )}
      <Link to="/">Back to games</Link>
    </div>
  );
}

export default Profile;
