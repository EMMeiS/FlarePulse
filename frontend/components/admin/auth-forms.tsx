import { useState } from "react";
import { Pending, type PendingState } from "@/components/pending";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useShake } from "@/lib/shake";

/**
 * The two signed-out screens. Both are uncontrolled: one `onSubmit` reads
 * `FormData` instead of a `useState` per field, which is less code and renders
 * identically on the server for the tests.
 */
export interface Credentials {
  username: string;
  password: string;
}

interface FormProps {
  onSubmit: (credentials: Credentials) => void;
  error: string | null;
  pending: PendingState;
  /** Failed attempts so far. Only ever read as a shake trigger. */
  attempt: number;
}

function credentials(form: HTMLFormElement): Credentials {
  const data = new FormData(form);
  return {
    username: String(data.get("username") ?? ""),
    password: String(data.get("password") ?? ""),
  };
}

function Card({
  title,
  shake,
  children,
}: {
  title: string;
  shake: number;
  children: React.ReactNode;
}) {
  const card = useShake<HTMLDivElement>(shake);

  return (
    <div
      ref={card}
      className="glass t-input mx-auto w-full max-w-sm space-y-4 rounded-xl border p-6"
    >
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}

function Alert({ message }: { message: string | null }) {
  return (
    <p role="alert" className="text-destructive min-h-5 text-sm">
      {message}
    </p>
  );
}

/** The one-time create-admin screen. It is gone for good afterwards. */
export function SetupForm({ onSubmit, error, pending, attempt }: FormProps) {
  const [mismatch, setMismatch] = useState(false);
  // Counted as well as flagged: the flag decides whether the message shows, the
  // count is what makes a second identical mismatch shake a second time.
  const [misses, setMisses] = useState(0);

  return (
    <Card title="Create the admin account" shake={attempt + misses}>
      <p className="text-muted-foreground text-sm">
        FlarePulse ships with no default credentials. This screen appears once and creates the only
        account for this instance.
      </p>

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          if (data.get("password") !== data.get("confirm")) {
            setMismatch(true);
            setMisses((count) => count + 1);
            return;
          }
          setMismatch(false);
          onSubmit(credentials(form));
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="setup-username">Username</Label>
          <Input id="setup-username" name="username" autoComplete="username" required minLength={3} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="setup-password">Password</Label>
          <Input
            id="setup-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
          />
          <p className="text-muted-foreground text-xs">At least 12 characters.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="setup-confirm">Repeat password</Label>
          <Input
            id="setup-confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
          />
        </div>

        <Alert message={mismatch ? "The two passwords do not match." : error} />

        <Button type="submit" disabled={pending === "busy"} className="w-full">
          <Pending state={pending} />
          {pending === "busy" ? "Creating…" : "Create account"}
        </Button>
      </form>
    </Card>
  );
}

export function LoginForm({ onSubmit, error, pending, attempt }: FormProps) {
  return (
    <Card title="Sign in" shake={attempt}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(credentials(event.currentTarget));
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="login-username">Username</Label>
          <Input id="login-username" name="username" autoComplete="username" required />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="login-password">Password</Label>
          <Input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>

        <Alert message={error} />

        <Button type="submit" disabled={pending === "busy"} className="w-full">
          <Pending state={pending} />
          {pending === "busy" ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </Card>
  );
}
