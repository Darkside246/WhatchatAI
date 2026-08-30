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

/**
 * ScreenLock (and the AlertNotifier it mounts) wraps ONLY the final,
 * fully-ready workspace - never onboarding/syncing/operator-setup. Those
 * earlier phases are still real pre-workspace screens (QR pairing, initial
 * sync progress) even though the human dashboard user is already
 * authenticated - alert banners naming the business's WhatsApp line and
 * urgency of unresolved handoffs have no business appearing on a screen
 * whose entire purpose is "connect WhatsApp," and a screen left open on
 * that step (a disconnected/re-pairing account, mid-onboarding) must never
 * surface live operational data to whoever can see the monitor.
 */
function AuthenticatedApp() {
  const gate = useAppGate();

  if (gate.phase === 'loading') {
    return <div className="flex h-full items-center justify-center bg-surface-0 text-body text-gray-400">Connecting to WhatchatAI backend…</div>;
  }
  if (gate.phase === 'onboarding') {
    return <OnboardingPage connection={gate.connection} />;
  }
  if (gate.phase === 'syncing') {
    return <SyncingPage connection={gate.connection} sync={gate.sync} onContinueAnyway={gate.continueAnyway} />;
  }
  if (gate.phase === 'operator-setup') {
    return <OperatorSetupPage onDone={gate.skipOperatorSetup} onSkip={gate.skipOperatorSetup} />;
  }

  return (
    <ScreenLock>
      <WorkspaceShell connection={gate.connection} sync={gate.sync} />
    </ScreenLock>
  );
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
