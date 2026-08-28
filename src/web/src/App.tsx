import { useLocation } from 'react-router-dom';
import { useAuth } from './hooks/useAuth.js';
import { useAppGate } from './hooks/useAppGate.js';
import { OnboardingPage } from './pages/OnboardingPage.js';
import { SyncingPage } from './pages/SyncingPage.js';
import { WorkspaceShell } from './pages/WorkspaceShell.js';
import { OperatorSetupPage } from './pages/OperatorSetupPage.js';
import { ScreenLock } from './components/ScreenLock.js';
import { LoginPage } from './pages/LoginPage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { PublicLandingPage, TrialStartPage } from './pages/PublicLandingPage.js';
import { TermsPage } from './pages/TermsPage.js';
import { PrivacyPage } from './pages/PrivacyPage.js';
import { ConsentConfirmPage } from './pages/ConsentConfirmPage.js';

function AuthenticatedApp() {
  const gate = useAppGate();

  let content;
  if (gate.phase === 'loading') {
    content = <div className="flex h-full items-center justify-center bg-surface-0 text-body text-gray-400">Connecting to WhatchatAI backend…</div>;
  } else if (gate.phase === 'onboarding') {
    content = <OnboardingPage connection={gate.connection} />;
  } else if (gate.phase === 'syncing') {
    content = <SyncingPage connection={gate.connection} sync={gate.sync} onContinueAnyway={gate.continueAnyway} />;
  } else if (gate.phase === 'operator-setup') {
    content = <OperatorSetupPage onDone={gate.skipOperatorSetup} onSkip={gate.skipOperatorSetup} />;
  } else {
    content = <WorkspaceShell connection={gate.connection} sync={gate.sync} />;
  }

  return <ScreenLock>{content}</ScreenLock>;
}

export default function App() {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === 'loading') {
    return <div className="flex h-full items-center justify-center bg-surface-0 text-body text-gray-400">Loading WhatchatAI…</div>;
  }

  if (auth.status === 'unauthenticated') {
    if (location.pathname === '/trial') return <TrialStartPage />;
    if (location.pathname === '/login') return <LoginPage />;
    if (location.pathname === '/register') return <RegisterPage />;
    if (location.pathname === '/terms') return <TermsPage />;
    if (location.pathname === '/privacy') return <PrivacyPage />;
    if (location.pathname === '/consent/confirm') return <ConsentConfirmPage />;
    return <PublicLandingPage />;
  }

  // Legal and consent pages accessible to everyone, even authenticated users.
  if (location.pathname === '/terms') return <TermsPage />;
  if (location.pathname === '/privacy') return <PrivacyPage />;
  if (location.pathname === '/consent/confirm') return <ConsentConfirmPage />;

  return <AuthenticatedApp />;
}
