import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { resetPassword } from '../services/api';
import { t } from '../i18n';

function Auth() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Shown once, and only here: the server keeps nothing but its hash.
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  const redirectTo = (location.state as { from?: string } | null)?.from ?? '/';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    if (mode === 'login') {
      login(username, password)
        .then(() => navigate(redirectTo, { replace: true }))
        .catch((err: Error) => setError(err.message))
        .finally(() => setSubmitting(false));
      return;
    }
    register(username, password)
      // The account exists either way; the code is shown before going on,
      // since there is no second chance to see it.
      .then((code) => (code ? setRecoveryCode(code) : navigate(redirectTo, { replace: true })))
      .catch((err: Error) => setError(err.message))
      .finally(() => setSubmitting(false));
  };

  if (recoveryCode) {
    return (
      <div className="auth-wrap">
        <h2>{t('Your recovery code')}</h2>
        <p className="muted">
          {t(
            "Write this down. It is the only way back into your account if you forget your password, and it isn't shown again.",
          )}
        </p>
        <p className="recovery-code">{recoveryCode}</p>
        <button type="button" onClick={() => navigate(redirectTo, { replace: true })}>
          {t('Done')}
        </button>
      </div>
    );
  }

  if (resetting) {
    return (
      <ResetPasswordForm
        initialUsername={username}
        onCancel={() => setResetting(false)}
        onReset={(code) => {
          setResetting(false);
          setRecoveryCode(code);
        }}
      />
    );
  }

  return (
    <div className="auth-wrap">
      <h2>{mode === 'login' ? t('Log in') : t('Create an account')}</h2>
      <form className="auth-form" onSubmit={submit}>
        <label>
          {t('Username')}
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            maxLength={12}
            required
          />
        </label>
        <label>
          {t('Password')}
          <div className="password-field">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              maxLength={128}
              required
            />
            <button
              type="button"
              className="password-toggle"
              aria-label={showPassword ? t('Hide password') : t('Show password')}
              onClick={() => setShowPassword((v) => !v)}
            >
              {showPassword ? (
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.42-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
                  />
                </svg>
              )}
            </button>
          </div>
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={submitting}>
          {mode === 'login' ? t('Log in') : t('Create account')}
        </button>
      </form>
      <button
        type="button"
        className="auth-switch"
        onClick={() => {
          setMode((m) => (m === 'login' ? 'register' : 'login'));
          setError(null);
        }}
      >
        {mode === 'login' ? t("Don't have an account? Register") : t('Already have an account? Log in')}
      </button>
      {mode === 'login' && (
        <button type="button" className="auth-switch" onClick={() => setResetting(true)}>
          {t('Forgot password?')}
        </button>
      )}
    </div>
  );
}

// No email to send a link to, so the proof is the code the account was
// given when it was made. Spending it sets a new password and issues the
// next one.
function ResetPasswordForm({
  initialUsername,
  onCancel,
  onReset,
}: {
  initialUsername: string;
  onCancel: () => void;
  onReset: (recoveryCode: string) => void;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    resetPassword(username, code, newPassword)
      .then(onReset)
      .catch((err: Error) => setError(err.message))
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="auth-wrap">
      <h2>{t('Forgot password')}</h2>
      <p className="muted">
        {t('The code you were given when the account was made. Using it sets a new password and gives you a new code.')}
      </p>
      <form className="auth-form" onSubmit={submit}>
        <label>
          {t('Username')}
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            maxLength={12}
            required
          />
        </label>
        <label>
          {t('Recovery code')}
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            spellCheck={false}
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
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={submitting}>
          {t('Reset')}
        </button>
      </form>
      <button type="button" className="auth-switch" onClick={onCancel}>
        {t('Cancel')}
      </button>
    </div>
  );
}

export default Auth;
