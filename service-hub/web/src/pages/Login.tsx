import { useState } from 'react';
import { useAuth } from '../auth';
import { Card, Field, useAction } from '../ui';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { run, busy } = useAction();
  return (
    <div className="login">
      <h1 style={{ color: 'var(--brand)', marginBottom: 14 }}>Service Hub</h1>
      <Card>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(() => login(email, password)); }}>
          <Field label="Email"><input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Password"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <button className="btn primary big" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </Card>
    </div>
  );
}
