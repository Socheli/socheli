import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="auth-shell">
      <div className="auth-aura" aria-hidden />
      <div className="auth-inner">
        <div className="auth-brand">
          <img src="/rem/logos/socheli-mark-light.png" alt="Socheli" className="auth-logo" />
          <div className="auth-wordmark">Socheli</div>
          <div className="auth-tag">Agentic content engine</div>
        </div>
        <SignUp />
        <div className="auth-foot">Access is invitation only — contact your admin.</div>
      </div>
    </div>
  );
}
