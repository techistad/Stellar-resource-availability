import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkAvailability,
  checkConnection,
  getCount,
  getResource,
  listResources,
  registerResource,
  releaseResource,
  reserveResource,
} from "../lib/stellar";

import "./App.css";

const nowTs = () => Math.floor(Date.now() / 1000);

const quickWindowOptions = [
  { label: "30 min", duration: 30 * 60 },
  { label: "1 hour", duration: 60 * 60 },
  { label: "2 hours", duration: 2 * 60 * 60 },
];

const initialForm = () => ({
  id: "res1",
  owner: "",
  name: "Conference Room A",
  resourceType: "room",
  capacity: "10",
  location: "Building 1, Floor 2",
  reserver: "",
  startTime: String(nowTs()),
  endTime: String(nowTs() + 3600),
});

const toOutput = (value) => {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
};

const truncateAddress = (addr) => {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
};

const formatTimestamp = (value) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "Enter a valid Unix timestamp";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(parsed * 1000));
};

const formatDuration = (startTime, endTime) => {
  const start = Number(startTime);
  const end = Number(endTime);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) {
    return "Set a valid reservation window";
  }

  const seconds = end - start;

  if (seconds <= 0) {
    return "End time must be after start time";
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes} min window`;
  }

  const hours = seconds / 3600;

  if (Number.isInteger(hours)) {
    return `${hours} hour window`;
  }

  return `${hours.toFixed(1)} hour window`;
};

const availabilityMeta = {
  unknown: {
    badge: "Unknown",
    summary: "Run a live availability check to confirm the on-chain status.",
  },
  available: {
    badge: "Available",
    summary: "This resource appears open for a new reservation window.",
  },
  reserved: {
    badge: "Reserved",
    summary: "This resource is currently marked unavailable or reserved.",
  },
};

export default function App() {
  const [form, setForm] = useState(initialForm);
  const [output, setOutput] = useState("Ready.");
  const [walletState, setWalletState] = useState("Wallet: not connected");
  const [walletKey, setWalletKey] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [countValue, setCountValue] = useState("...");
  const [isCountLoading, setIsCountLoading] = useState(true);
  const [status, setStatus] = useState("idle");
  const [confirmAction, setConfirmAction] = useState(null);
  const [availabilityState, setAvailabilityState] = useState("unknown");
  const [lastAction, setLastAction] = useState("Waiting for your first contract action");
  const [lastUpdated, setLastUpdated] = useState("No activity yet");
  const confirmTimer = useRef(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      clearTimeout(confirmTimer.current);
    };
  }, []);

  const setField = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const stampActivity = (label) => {
    setLastAction(label);
    setLastUpdated(
      new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date()),
    );
  };

  const refreshCountValue = useCallback(
    async ({ onErrorValue, rethrow = false } = {}) => {
      if (mountedRef.current) {
        setIsCountLoading(true);
      }

      try {
        const value = await getCount();

        if (mountedRef.current) {
          setCountValue(String(value));
        }

        return value;
      } catch (error) {
        if (mountedRef.current && onErrorValue !== undefined) {
          setCountValue(onErrorValue);
        }

        if (rethrow) {
          throw error;
        }

        return null;
      } finally {
        if (mountedRef.current) {
          setIsCountLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void refreshCountValue({ onErrorValue: "Unavailable" });
  }, [refreshCountValue]);

  const runAction = async (action, actionName, options = {}) => {
    setIsBusy(true);
    setBusyAction(actionName || "");

    try {
      const result = await action();
      setOutput(toOutput(result ?? "No data found"));
      setStatus("success");
      stampActivity(options.successLabel || "Action completed");
      options.onSuccess?.(result);
    } catch (error) {
      setOutput(error?.message || String(error));
      setStatus("error");
      stampActivity(options.errorLabel || `${options.successLabel || "Action"} failed`);
      options.onError?.(error);
    } finally {
      setIsBusy(false);
      setBusyAction("");
    }
  };

  const applyWindowPreset = (duration) => {
    const start = nowTs();
    setForm((prev) => ({
      ...prev,
      startTime: String(start),
      endTime: String(start + duration),
    }));
  };

  const onConnect = () =>
    runAction(
      async () => {
        const user = await checkConnection();
        const next = user ? `Wallet: ${user.publicKey}` : "Wallet: not connected";
        setWalletState(next);

        if (user) {
          setWalletKey(user.publicKey);
          setForm((prev) => ({
            ...prev,
            owner: user.publicKey,
            reserver: user.publicKey,
          }));
        } else {
          setWalletKey("");
        }

        return next;
      },
      "connect",
      {
        successLabel: "Wallet connection refreshed",
        errorLabel: "Wallet connection failed",
      },
    );

  const onRegister = () =>
    runAction(
      async () =>
        registerResource({
          id: form.id.trim(),
          owner: form.owner.trim(),
          name: form.name.trim(),
          resourceType: form.resourceType.trim(),
          capacity: form.capacity.trim(),
          location: form.location.trim(),
        }),
      "register",
      {
        successLabel: "Resource registered",
        errorLabel: "Resource registration failed",
        onSuccess: () => {
          setAvailabilityState("unknown");
          void refreshCountValue();
        },
      },
    );

  const onReserve = () =>
    runAction(
      async () =>
        reserveResource({
          id: form.id.trim(),
          reserver: form.reserver.trim() || form.owner.trim(),
          startTime: Number(form.startTime || nowTs()),
          endTime: Number(form.endTime || nowTs() + 3600),
        }),
      "reserve",
      {
        successLabel: "Reservation submitted",
        errorLabel: "Reservation failed",
        onSuccess: () => setAvailabilityState("reserved"),
      },
    );

  const handleRelease = () => {
    if (confirmAction === "release") {
      clearTimeout(confirmTimer.current);
      setConfirmAction(null);

      runAction(
        async () =>
          releaseResource({
            id: form.id.trim(),
            reserver: form.reserver.trim() || form.owner.trim(),
          }),
        "release",
        {
          successLabel: "Reservation released",
          errorLabel: "Release failed",
          onSuccess: () => setAvailabilityState("available"),
        },
      );

      return;
    }

    setConfirmAction("release");
    clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmAction(null), 3000);
  };

  const onCheckAvailability = () =>
    runAction(
      async () => {
        const available = await checkAvailability(form.id.trim());
        return { resourceId: form.id.trim(), available };
      },
      "check",
      {
        successLabel: "Availability checked",
        errorLabel: "Availability check failed",
        onSuccess: (result) =>
          setAvailabilityState(result?.available ? "available" : "reserved"),
      },
    );

  const onGetResource = () =>
    runAction(async () => getResource(form.id.trim()), "getResource", {
      successLabel: "Resource data loaded",
      errorLabel: "Resource lookup failed",
    });

  const onList = () =>
    runAction(async () => listResources(), "list", {
      successLabel: "Resource list loaded",
      errorLabel: "Resource listing failed",
    });

  const onCount = () =>
    runAction(
      async () => {
        const value = await refreshCountValue({
          onErrorValue: "Unavailable",
          rethrow: true,
        });
        return { count: value };
      },
      "count",
      {
        successLabel: "Resource count refreshed",
        errorLabel: "Resource count failed",
      },
    );

  const isConnected = walletKey.length > 0;
  const availabilityInfo = availabilityMeta[availabilityState] || availabilityMeta.unknown;
  const reservationDuration = formatDuration(form.startTime, form.endTime);
  const reservationStartLabel = formatTimestamp(form.startTime);
  const reservationEndLabel = formatTimestamp(form.endTime);
  const activeAddress = form.reserver.trim() || form.owner.trim() || "Awaiting an address";
  const resourceSignature = `${form.resourceType || "resource"} / cap ${form.capacity || "-"}`;

  const btnLoadingText = (actionName, label) => {
    if (isBusy && busyAction === actionName) return "Processing...";
    return label;
  };

  const btnCls = (actionName, base) => {
    let cls = base;

    if (isBusy && busyAction === actionName) {
      cls += " btn-loading";
    }

    return cls;
  };

  const outputClass = () => {
    if (status === "success") return "output-success";
    if (status === "error") return "output-error";
    return "output-idle";
  };

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="hero-kicker">Stellar Soroban Project 2</p>
          <h1>Resource operations, reservation timing, and live contract output in one workspace.</h1>
          <p className="hero-summary">
            This dashboard keeps the existing wallet and contract actions intact,
            while making registration, reservation, availability checks, and
            responses easier to scan and operate.
          </p>
          <div className="hero-tags">
            <span className="hero-tag">Soroban testnet</span>
            <span className={`hero-tag ${isConnected ? "hero-tag-live" : "hero-tag-muted"}`}>
              {isConnected ? "Wallet connected" : "Wallet disconnected"}
            </span>
            <span className={`hero-tag hero-tag-${availabilityState}`}>
              Availability {availabilityInfo.badge}
            </span>
          </div>
        </div>

        <div className="hero-metrics">
          <article className="metric-tile">
            <span className="metric-label">Registered resources</span>
            <strong className="metric-value">{countValue}</strong>
            <p className="metric-note">
              {isCountLoading
                ? "Syncing the latest count from the contract..."
                : 'Auto-synced from the contract. Use "Get Count" to refresh manually.'}
            </p>
          </article>

          <article className="metric-tile">
            <span className="metric-label">Reservation window</span>
            <strong className="metric-value metric-value-small">{reservationDuration}</strong>
            <p className="metric-note">Start and end timestamps are converted into a readable schedule.</p>
          </article>

          <article className="metric-tile">
            <span className="metric-label">Last activity</span>
            <strong className="metric-value metric-value-small">{lastUpdated}</strong>
            <p className="metric-note">{lastAction}</p>
          </article>
        </div>
      </section>

      <section className="workspace">
        <div className="workspace-main">
          <article className="panel-card">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Resource Setup</p>
                <h2>Registration details</h2>
              </div>
              <span className="panel-chip">{resourceSignature}</span>
            </div>

            <div className="field-grid">
              <label className="field field-span-2" htmlFor="entryId">
                <span>Resource ID</span>
                <input id="entryId" name="id" value={form.id} onChange={setField} />
                <small>Unique identifier used for lookups, reservations, and releases.</small>
              </label>

              <label className="field field-span-2" htmlFor="owner">
                <span>Owner address</span>
                <input
                  id="owner"
                  name="owner"
                  value={form.owner}
                  onChange={setField}
                  placeholder="G..."
                />
                <small>Prefilled from Freighter once the wallet is connected.</small>
              </label>

              <label className="field" htmlFor="name">
                <span>Resource name</span>
                <input id="name" name="name" value={form.name} onChange={setField} />
                <small>Use a human-friendly label that operators can recognize quickly.</small>
              </label>

              <label className="field" htmlFor="resourceType">
                <span>Type</span>
                <input
                  id="resourceType"
                  name="resourceType"
                  value={form.resourceType}
                  onChange={setField}
                  placeholder="room, vehicle, equipment..."
                />
                <small>Keep the type compact because it becomes part of the on-chain record.</small>
              </label>

              <label className="field" htmlFor="capacity">
                <span>Capacity</span>
                <input
                  id="capacity"
                  name="capacity"
                  value={form.capacity}
                  onChange={setField}
                  type="number"
                />
                <small>Numeric value stored on-chain as an unsigned integer.</small>
              </label>

              <label className="field" htmlFor="location">
                <span>Location</span>
                <input
                  id="location"
                  name="location"
                  value={form.location}
                  onChange={setField}
                />
                <small>Helpful context for teams sharing the same resource catalog.</small>
              </label>
            </div>

            <div className="action-row action-row-tight">
              <button
                type="button"
                className={btnCls("register", "btn btn-primary")}
                onClick={onRegister}
                disabled={isBusy}
              >
                {btnLoadingText("register", "Register Resource")}
              </button>
              <button
                type="button"
                className={btnCls("getResource", "btn btn-secondary")}
                onClick={onGetResource}
                disabled={isBusy}
              >
                {btnLoadingText("getResource", "Get Resource")}
              </button>
              <button
                type="button"
                className={btnCls("list", "btn btn-secondary")}
                onClick={onList}
                disabled={isBusy}
              >
                {btnLoadingText("list", "List All")}
              </button>
              <button
                type="button"
                className={btnCls("count", "btn btn-secondary")}
                onClick={onCount}
                disabled={isBusy}
              >
                {btnLoadingText("count", "Get Count")}
              </button>
            </div>
          </article>

          <article className="panel-card">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Reservation Flow</p>
                <h2>Manage reservation timing</h2>
              </div>
              <span className={`availability-pill availability-pill-${availabilityState}`}>
                {availabilityInfo.badge}
              </span>
            </div>

            <div className="summary-strip">
              <div className="summary-box">
                <span className="summary-label">Starts</span>
                <strong>{reservationStartLabel}</strong>
              </div>
              <div className="summary-box">
                <span className="summary-label">Ends</span>
                <strong>{reservationEndLabel}</strong>
              </div>
              <div className="summary-box">
                <span className="summary-label">Status</span>
                <strong>{availabilityInfo.summary}</strong>
              </div>
            </div>

            <div className="preset-row">
              <span className="preset-label">Quick windows</span>
              <div className="preset-actions">
                {quickWindowOptions.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className="preset-button"
                    onClick={() => applyWindowPreset(option.duration)}
                    disabled={isBusy}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="field-grid">
              <label className="field field-span-2" htmlFor="reserver">
                <span>Reserver address</span>
                <input
                  id="reserver"
                  name="reserver"
                  value={form.reserver}
                  onChange={setField}
                  placeholder="G... (defaults to owner)"
                />
                <small>Leave blank to fall back to the owner address during contract calls.</small>
              </label>

              <label className="field" htmlFor="startTime">
                <span>Start time</span>
                <input
                  id="startTime"
                  name="startTime"
                  value={form.startTime}
                  onChange={setField}
                  type="number"
                />
                <small>Unix timestamp in seconds.</small>
              </label>

              <label className="field" htmlFor="endTime">
                <span>End time</span>
                <input
                  id="endTime"
                  name="endTime"
                  value={form.endTime}
                  onChange={setField}
                  type="number"
                />
                <small>Unix timestamp in seconds.</small>
              </label>
            </div>

            <div className="action-row">
              <button
                type="button"
                className={btnCls("reserve", "btn btn-primary")}
                onClick={onReserve}
                disabled={isBusy}
              >
                {btnLoadingText("reserve", "Reserve Resource")}
              </button>
              <button
                type="button"
                className={`${btnCls("release", "btn btn-danger")} ${confirmAction === "release" ? "btn-confirm" : ""}`}
                onClick={handleRelease}
                disabled={isBusy}
              >
                {confirmAction === "release"
                  ? "Confirm Release?"
                  : btnLoadingText("release", "Release Resource")}
              </button>
              <button
                type="button"
                className={btnCls("check", "btn btn-ghost")}
                onClick={onCheckAvailability}
                disabled={isBusy}
              >
                {btnLoadingText("check", "Check Availability")}
              </button>
            </div>
          </article>
        </div>

        <aside className="workspace-rail">
          <article className="panel-card panel-card-accent">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Wallet</p>
                <h2>Freighter connection</h2>
              </div>
              <span className={`status-pill ${isConnected ? "status-pill-live" : "status-pill-off"}`}>
                {isConnected ? "Connected" : "Offline"}
              </span>
            </div>

            <button
              type="button"
              className={btnCls("connect", "btn btn-primary btn-block")}
              id="connectWallet"
              onClick={onConnect}
              disabled={isBusy}
            >
              {btnLoadingText("connect", "Connect Freighter")}
            </button>

            <div className="info-list">
              <div className="info-row">
                <span>Wallet state</span>
                <strong id="walletState">{walletState}</strong>
              </div>
              <div className="info-row">
                <span>Displayed key</span>
                <strong>{isConnected ? truncateAddress(walletKey) : "Not connected"}</strong>
              </div>
              <div className="info-row">
                <span>Active signer</span>
                <strong>{truncateAddress(activeAddress)}</strong>
              </div>
            </div>
          </article>

          <article className="panel-card">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Snapshot</p>
                <h2>Current resource context</h2>
              </div>
              <span className="panel-chip">{form.id || "No ID"}</span>
            </div>

            <div className="snapshot-grid">
              <div className="snapshot-item">
                <span>Name</span>
                <strong>{form.name || "Untitled resource"}</strong>
              </div>
              <div className="snapshot-item">
                <span>Type</span>
                <strong>{form.resourceType || "Unknown"}</strong>
              </div>
              <div className="snapshot-item">
                <span>Capacity</span>
                <strong>{form.capacity || "-"}</strong>
              </div>
              <div className="snapshot-item">
                <span>Location</span>
                <strong>{form.location || "Not specified"}</strong>
              </div>
            </div>
          </article>

          <article className="panel-card panel-card-console">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Status Panel</p>
                <h2>Live contract output</h2>
              </div>
              <span className={`status-pill status-pill-${status}`}>{status}</span>
            </div>

            <div className={`status-output ${outputClass()}`}>
              <div className="status-bar">
                <span className="status-dot-live"></span>
                <span>Last update {lastUpdated}</span>
              </div>

              {output === "Ready." ? (
                <div className="empty-state">
                  <div className="empty-icon">[]</div>
                  <p>Connect the wallet or trigger a contract action to stream output here.</p>
                </div>
              ) : (
                <pre id="output">{output}</pre>
              )}
            </div>
          </article>
        </aside>
      </section>
    </main>
  );
}
