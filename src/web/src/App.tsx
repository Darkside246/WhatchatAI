import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from './hooks/useAuth.js';
import { useAppGate } from './hooks/useAppGate.js';
import { applyBrandTheme } from './lib/brandTheme.js';
import { OnboardingPage } from './pages/OnboardingPage.js';
import { SyncingPage } from './pages/SyncingPage.js';
import { WorkspaceShell } from './pages/WorkspaceShell.js';
import { OperatorSetupPage } from './pages/OperatorSetupPage.js';
import { BrandDnaPage } from './pages/BrandDnaPage.js';
import { ScreenLock } from './components/ScreenLock.js';
import { LoginPage } from './pages/LoginPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { VerifyEmailPage } from './pages/VerifyEmailPage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { PublicLandingPage, TrialStartPage } from './pages/PublicLandingPage.js';
import { TermsPage } from './pages/TermsPage.js';
import { PrivacyPage } from './pages/PrivacyPage.js';
import { ConsentConfirmPage } from './pages/ConsentConfirmPage.js';

/**
 * ScreenLock wraps ONLY the final, fully-ready workspace - never
 * onboarding/syncing/operator-setup. Those earlier phases are still real
 * pre-workspace screens (QR pairing, initial sync progress) even though the
 * human dashboard user is already authenticated - so a screen left open
 * mid-onboarding (a disconnected/re-pairing account) never surfaces live
 * operational data to whoever can see the monitor. AlertNotifier (the
 * urgent lead-handover pill) is mounted twice for the same reason and
 * nowhere else: inside WorkspaceShell's own header for the normal unlocked
 * view, and again inside ScreenLock's own lock overlay (off to the side of
 * the PIN card) so a live handoff stays visible while locked instead of
 * disappearing along with the rest of the header underneath.
 */
function AuthenticatedApp() {
  const gate = useAppGate();

  if (gate.phase === 'loading') {
    return <div className="flex h-full items-center justify-center bg-surface-0 text-body text-gray-400">Connecting to AURA backend…</div>;
  }
  if (gate.phase === 'onboarding') {
    return <OnboardingPage connection={gate.connection} serverUnreachable={gate.serverUnreachable} />;
  }
  if (gate.phase === 'syncing') {
    return <SyncingPage connection={gate.connection} sync={gate.sync} onContinueAnyway={gate.continueAnyway} />;
  }
  if (gate.phase === 'operator-setup') {
    return <OperatorSetupPage onDone={gate.skipOperatorSetup} onSkip={gate.skipOperatorSetup} />;
  }
  if (gate.phase === 'brand-dna') {
    return <BrandDnaPage onDone={gate.skipBrandDna} onSkip={gate.skipBrandDna} />;
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

  // Applied at this top level (not inside AuthenticatedApp) so it resets to
  // the app default the moment a business's data leaves scope, e.g. logout.
  useEffect(() => {
    applyBrandTheme(auth.business?.brandColor ?? null);
  }, [auth.business?.brandColor]);

  if (auth.status === 'loading') {
    return <div className="flex h-full items-center justify-center bg-surface-0 text-body text-gray-400">Loading AURA…</div>;
  }

  if (auth.status === 'unauthenticated') {
    if (location.pathname === '/trial') return <TrialStartPage />;
    if (location.pathname === '/login') return <LoginPage />;
    if (location.pathname === '/reset-password') return <ResetPasswordPage />;
    if (location.pathname === '/verify-email') return <VerifyEmailPage />;
    if (location.pathname === '/register') return <RegisterPage />;
    if (location.pathname === '/terms') return <TermsPage />;
    if (location.pathname === '/privacy') return <PrivacyPage />;
    if (location.pathname === '/consent/confirm') return <ConsentConfirmPage />;
    return <PublicLandingPage />;
  }

  // Reachable while signed in as well. A reset link can be opened in a
  // browser that still has a live session - often the very device someone
  // is locked out of elsewhere - and redirecting them into the workspace
  // would strand the link they were sent.
  if (location.pathname === '/reset-password') return <ResetPasswordPage />;
  // Same reasoning: the confirmation link is often opened on the phone that
  // is already signed in, and bouncing it to the workspace would leave the
  // address unverified with no obvious way to retry.
  if (location.pathname === '/verify-email') return <VerifyEmailPage />;

  // Legal and consent pages accessible to everyone, even authenticated users.
  if (location.pathname === '/terms') return <TermsPage />;
  if (location.pathname === '/privacy') return <PrivacyPage />;
  if (location.pathname === '/consent/confirm') return <ConsentConfirmPage />;

  return <AuthenticatedApp />;
}
