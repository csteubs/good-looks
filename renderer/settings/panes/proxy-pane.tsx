// Settings → Proxy, modelled on the mabl Desktop App's proxy settings: which
// traffic (None / App / Test / Both), from where (Automatic / Manual), the
// manual URL and credentials, SSL Verify, and a validate dialog with one
// check per traffic class.
//
// Three deliberate departures from the mabl original, recorded here because
// "as close as possible" was the brief:
//   • No Save/Cancel bar — every row saves immediately, like the rest of this
//     window, and mabl's Reset is this window's standard "Reset section"
//     footer (the password is credential-backed and excluded, same as every
//     other credential here).
//   • No "Apply to app view" checkbox. mabl's app view is a remote web app;
//     this app's windows are served over app:// from disk, so there is no app
//     view traffic to proxy.
//   • The URL refuses embedded credentials. The URL is stored in plain
//     settings JSON; the password field exists so the secret is stored
//     encrypted instead, and accepting `user:pass@host` would quietly undo
//     that split.
//
// The manual rows unmount in automatic mode rather than grey out — the same
// dependent-row idiom as the Linear destination rows. The validate dialog
// carries mabl's own caveat: a validation can disagree with a real run.

import { useState } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Status,
  Switch,
  toast,
} from "@ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";
import type { ProxyVerifyResult } from "../../lib/recorder-types";
import type { ProxySource, ProxyTraffic } from "../../lib/recorder-types";
import { normalizeProxyUrl, proxyAppliesTo } from "../../../shared/proxy-config.mjs";
import { useSettingsController } from "../settings-controller";
import { SettingRow } from "../setting-row";
import { PaneSection } from "../pane-section";

const TRAFFIC_LABELS: Record<ProxyTraffic, string> = {
  none: "None",
  app: "App",
  test: "Test",
  both: "Both",
};

/** One validate check's row: the button, its pending state, and the outcome. */
function VerifyBlock({
  heading,
  enabled,
  buttonLabel,
  onVerify,
  pending,
  result,
  children,
}: {
  heading: string;
  enabled: boolean;
  buttonLabel: string;
  onVerify: () => void;
  pending: boolean;
  result: ProxyVerifyResult | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">
        {heading} — {enabled ? "proxy settings apply" : "proxy settings do not apply"}
      </p>
      {children}
      <div>
        <Button variant="secondary" onClick={onVerify} disabled={pending}>
          {pending ? "Checking…" : buttonLabel}
        </Button>
      </div>
      {result ? (
        <div className="flex flex-col gap-1" role="status">
          <div className="flex items-center gap-2">
            <Status variant={result.ok ? "success" : "error"}>
              {result.ok ? "Reachable" : "Failed"}
            </Status>
            <span className="text-sm">{result.detail}</span>
          </div>
          <p className="text-secondary text-sm">
            Checked {result.url} — {result.via}.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** The mabl-style "Validate Proxy Settings" dialog: verify app connectivity,
 *  and verify a user-typed URL as test traffic. Neither check throws — a
 *  failure is the answer, rendered in place. */
function ValidateProxyDialog({
  open,
  onOpenChange,
  appEnabled,
  testEnabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appEnabled: boolean;
  testEnabled: boolean;
}) {
  const [testUrl, setTestUrl] = useState("");
  const verifyApp = useMutation({ mutationFn: () => api.proxy.verifyApp() });
  const verifyTest = useMutation({ mutationFn: (url: string) => api.proxy.verifyTest(url) });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Validate proxy settings</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-6">
          <VerifyBlock
            heading="App traffic"
            enabled={appEnabled}
            buttonLabel="Verify app connectivity"
            onVerify={() => verifyApp.mutate()}
            pending={verifyApp.isPending}
            result={verifyApp.data ?? null}
          />
          <VerifyBlock
            heading="Test traffic"
            enabled={testEnabled}
            buttonLabel="Verify test connectivity"
            onVerify={() => verifyTest.mutate(testUrl.trim())}
            pending={verifyTest.isPending}
            result={verifyTest.data ?? null}
          >
            <Input
              aria-label="URL to test"
              placeholder="https://staging.example.com"
              value={testUrl}
              onChange={(e) => setTestUrl(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </VerifyBlock>
          {/* mabl's caveat, kept: proxy implementations vary, and the check
              shares the network stack without being a browser run. */}
          <p className="text-secondary text-sm">
            A validation can behave differently from a real run — proxy implementations vary. If a
            check fails here but the settings look right, record or run a real test before
            trusting the failure.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProxyPane() {
  const { settings, save } = useSettingsController();
  const qc = useQueryClient();

  const traffic: ProxyTraffic = settings.proxyTraffic ?? "none";
  const source: ProxySource = settings.proxySource ?? "automatic";
  const sslVerify = settings.proxySslVerify ?? true;
  const manual = source === "manual";
  const appEnabled = proxyAppliesTo({ proxyTraffic: traffic }, "app");
  const testEnabled = proxyAppliesTo({ proxyTraffic: traffic }, "test");

  // Text fields hold local drafts and commit on blur/Enter, so half-typed
  // values never hit the store's validation. `null` = no draft, show saved.
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [usernameDraft, setUsernameDraft] = useState<string | null>(null);
  const [passwordInput, setPasswordInput] = useState("");
  const [validateOpen, setValidateOpen] = useState(false);

  const passwordStatus = useQuery({
    queryKey: ["proxy-password-status"],
    queryFn: () => api.proxy.hasPassword(),
  });
  const hasPassword = passwordStatus.data?.hasPassword ?? false;

  const savePassword = useMutation({
    mutationFn: (password: string) => api.proxy.setPassword(password),
    onSuccess: (status) => {
      qc.setQueryData(["proxy-password-status"], status);
      setPasswordInput("");
      toast.success("Saved the proxy password.");
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : String(err)),
  });
  const clearPassword = useMutation({
    mutationFn: () => api.proxy.clearPassword(),
    onSuccess: (status) => {
      qc.setQueryData(["proxy-password-status"], status);
      toast.success("Removed the proxy password.");
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : String(err)),
  });
  const passwordBusy = savePassword.isPending || clearPassword.isPending;

  const commitUrl = (): void => {
    if (urlDraft === null) return;
    const trimmed = urlDraft.trim();
    if (trimmed === (settings.proxyUrl ?? "")) {
      setUrlDraft(null);
      return;
    }
    if (trimmed === "") {
      void save({ proxyUrl: "" });
      setUrlDraft(null);
      return;
    }
    const result = normalizeProxyUrl(trimmed);
    if (!result.ok) {
      // Keep the draft — wiping a mistyped URL gives nothing to correct.
      toast.error(result.reason);
      return;
    }
    void save({ proxyUrl: result.url });
    setUrlDraft(null);
  };

  const commitUsername = (): void => {
    if (usernameDraft === null) return;
    void save({ proxyUsername: usernameDraft.trim() });
    setUsernameDraft(null);
  };

  return (
    <PaneSection>
      <SettingRow
        id="proxy-traffic"
        label="Traffic to proxy"
        summary={
          <>
            <strong>App</strong> is traffic from Good Looks! itself — the AI provider, GitHub,
            webhooks, site icons and browser downloads. <strong>Test</strong> is the system under
            test's traffic: the training browser and every test run, including runs started from
            the MCP server. <strong>Both</strong> is both. <strong>None</strong> ignores the
            settings below without erasing them, so turning the proxy off for a check doesn't mean
            retyping it.
          </>
        }
      >
        <Select
          value={traffic}
          onValueChange={(v) => void save({ proxyTraffic: v as ProxyTraffic })}
        >
          <SelectTrigger id="proxy-traffic" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(TRAFFIC_LABELS) as ProxyTraffic[]).map((value) => (
              <SelectItem key={value} value={value}>
                {TRAFFIC_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow
        id="proxy-source"
        label="Proxy settings source"
        summary="Automatic detects the proxy from this Mac's network settings, PAC files included. Manual uses the URL and credentials below instead."
      >
        <Select
          value={source}
          onValueChange={(v) => void save({ proxySource: v as ProxySource })}
        >
          <SelectTrigger id="proxy-source" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="automatic">Automatic (recommended)</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      {manual ? (
        <SettingRow
          id="proxy-url"
          label="Proxy URL"
          nested
          stacked
          summary="scheme://host:port — http, https or socks5. Leave credentials out of the URL: it is stored in plain settings, and the password field below is stored encrypted instead."
        >
          <Input
            id="proxy-url"
            className="w-full"
            placeholder="http://192.168.0.1:8080"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={urlDraft ?? settings.proxyUrl ?? ""}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={commitUrl}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitUrl();
            }}
          />
        </SettingRow>
      ) : null}

      {manual ? (
        <SettingRow
          id="proxy-username"
          label="Username"
          nested
          summary="Only if the proxy asks for a login."
        >
          <Input
            id="proxy-username"
            className="w-64"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={usernameDraft ?? settings.proxyUsername ?? ""}
            onChange={(e) => setUsernameDraft(e.target.value)}
            onBlur={commitUsername}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitUsername();
            }}
          />
        </SettingRow>
      ) : null}

      {manual ? (
        <SettingRow
          id="proxy-password"
          label="Password"
          nested
          stacked
          flag="stores credentials"
          summary="Stored encrypted on this Mac and never shown again; paste a new one to replace it. It is sent only to the proxy above. Runs started from the MCP server can't decrypt it — they reach an authenticating proxy without it, and their run report says so."
        >
          <div className="flex w-full items-center gap-2">
            {hasPassword ? <Status variant="success">Saved</Status> : null}
            <Input
              id="proxy-password"
              type="password"
              className="min-w-0 flex-1"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={hasPassword ? "••••••••" : "Proxy password"}
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              disabled={passwordBusy}
            />
            <Button
              variant="secondary"
              aria-label="Save proxy password"
              onClick={() => void savePassword.mutateAsync(passwordInput).catch(() => {})}
              disabled={passwordBusy || passwordInput.trim().length === 0}
            >
              {savePassword.isPending ? "Saving…" : "Save"}
            </Button>
            {hasPassword ? (
              <Button
                variant="secondary"
                aria-label="Remove proxy password"
                onClick={() => void clearPassword.mutateAsync().catch(() => {})}
                disabled={passwordBusy}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </SettingRow>
      ) : null}

      {manual ? (
        <SettingRow
          id="proxy-ssl-verify"
          label="SSL Verify"
          nested
          summary="Verify TLS certificates on connections that go through this proxy. Turn off only for a proxy that re-signs traffic with its own certificate — direct connections and localhost stay verified either way."
          risk={
            sslVerify
              ? undefined
              : "Certificates on proxied connections are not verified: anything between this proxy and the site can read and rewrite that traffic without being noticed. Test runs make the same exception (ignoreHTTPSErrors)."
          }
        >
          <Switch
            id="proxy-ssl-verify"
            checked={sslVerify}
            onCheckedChange={(checked) => void save({ proxySslVerify: checked })}
          />
        </SettingRow>
      ) : null}

      <SettingRow
        id="proxy-validate"
        label="Validate proxy settings"
        summary="One request per traffic class, through exactly the path it would really take — app traffic to the active AI provider, test traffic to a URL you name."
      >
        <Button
          id="proxy-validate"
          variant="secondary"
          onClick={() => setValidateOpen(true)}
        >
          Validate…
        </Button>
      </SettingRow>

      <ValidateProxyDialog
        open={validateOpen}
        onOpenChange={setValidateOpen}
        appEnabled={appEnabled}
        testEnabled={testEnabled}
      />
    </PaneSection>
  );
}
