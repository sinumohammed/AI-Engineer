import { Alert, Button, Progress, Segmented, Select, Switch, Tooltip, Typography, theme } from "antd";
import {
  ApartmentOutlined,
  BulbOutlined,
  DownloadOutlined,
  MoonOutlined,
  PlusOutlined,
  RobotOutlined,
  SunOutlined,
} from "@ant-design/icons";
import { usePwaInstall } from "./usePwaInstall.js";

const { Text } = Typography;

// `synthesizer` is the step that joins several specialists' answers (8b).
export const AGENT_LABELS = { company_docs: "Company docs", coding: "Coding", general: "General", synthesizer: "Combined" };

const LEVEL_COLORS = { warning: "#d97706", critical: "#dc2626" };

// How full this conversation's context window is, and how many exchanges are
// still remembered word for word before the oldest get summarised (6.9, 6.11).
export function ContextMeter({ usage, memory, size = 84 }) {
  const { token } = theme.useToken();
  const total = usage?.contextWindow ?? 8192;
  const used = usage?.totalTokens ?? 0;
  const percent = usage ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const color = LEVEL_COLORS[usage?.warningLevel] ?? token.colorPrimary;
  return (
    <div className="meter">
      <Progress type="dashboard" size={size} percent={percent} strokeColor={color} format={() => (usage ? `${percent}%` : "—")} />
      <div className="meter-text">
        <Text strong>Context used</Text>
        <Text type="secondary" className="small">
          {usage ? `${used.toLocaleString()} of ${total.toLocaleString()} tokens` : "No questions yet"}
        </Text>
        {memory && (
          <Tooltip title="Exchanges still remembered word for word, before the oldest are folded into a summary">
            <Text type="secondary" className="small">
              {memory.turnsRemaining} of {memory.maxTurns} turns left{memory.hasSummary ? " · older turns summarised" : ""}
            </Text>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export function Brand({ compact = false }) {
  return (
    <div className="brand">
      <img src="/favicon.svg" alt="" width={compact ? 28 : 36} height={compact ? 28 : 36} />
      <div className="brand-text">
        <span className="brand-name">Agent Chat</span>
        {!compact && <span className="brand-sub">Handbook, coding and general questions</span>}
      </div>
    </div>
  );
}

export default function Sidebar({ state, newChat, setMode, setAgent, themeMode, setThemeMode, canSpeak, voiceAutoSend, setVoiceAutoSend, voiceLanguage, setVoiceLanguage, onDone }) {
  const pwa = usePwaInstall();
  const close = (fn) => (...args) => {
    fn(...args);
    onDone?.();
  };

  return (
    <div className="side">
      <Brand />

      <Button type="primary" size="large" icon={<PlusOutlined />} block onClick={close(newChat)} disabled={state.busy}>
        New chat
      </Button>

      <section>
        <div className="side-label">Answer with</div>
        {/* Phase 8c: which backend answers the next question. Both share the
            same conversation, so switching keeps the history. */}
        <Segmented
          block
          value={state.mode}
          onChange={setMode}
          disabled={state.busy}
          options={[
            { value: "single", label: "Single agent", icon: <RobotOutlined /> },
            { value: "multi", label: "Multi-agent", icon: <ApartmentOutlined /> },
          ]}
        />
        <Text type="secondary" className="small">
          {state.mode === "single"
            ? "One agent searches the handbook and answers."
            : "A router splits the question and hands each part to a specialist."}
        </Text>
      </section>

      {state.mode === "multi" && (
        <section>
          <div className="side-label">Specialist</div>
          {/* Manual override: "Auto" lets the router pick; a specialist skips
              the router for the next questions. Amber while active, so it is
              not forgotten. */}
          <Select
            value={state.agent}
            onChange={setAgent}
            disabled={state.busy}
            status={state.agent !== "auto" ? "warning" : undefined}
            options={[
              { value: "auto", label: "Auto - the router decides" },
              { value: "company_docs", label: AGENT_LABELS.company_docs },
              { value: "coding", label: AGENT_LABELS.coding },
              { value: "general", label: AGENT_LABELS.general },
            ]}
          />
          {state.agent !== "auto" && (
            <Text type="warning" className="small">
              Every question goes to {AGENT_LABELS[state.agent]} until you switch back to Auto.
            </Text>
          )}
        </section>
      )}

      <section>
        <div className="side-label">This conversation</div>
        <ContextMeter usage={state.usage} memory={state.memory} />
      </section>

      {canSpeak && (
        <section>
          <div className="side-label">Voice</div>
          {/* A hint for the speech-to-text model: auto-detect handles English
              well, but Malayalam can come back romanised or in another
              script unless it is named (api/transcribe.js). */}
          <Select
            value={voiceLanguage}
            onChange={setVoiceLanguage}
            options={[
              { value: "auto", label: "I speak: detect automatically" },
              ...["English", "Malayalam", "Hindi", "Tamil", "Kannada", "Telugu", "Arabic", "Urdu", "Spanish", "French"].map((l) => ({ value: l, label: `I speak: ${l}` })),
            ]}
          />
          <label className="switch-row">
            <span>Send as soon as I stop talking</span>
            <Switch size="small" checked={voiceAutoSend} onChange={setVoiceAutoSend} />
          </label>
          <Text type="secondary" className="small">
            {voiceAutoSend
              ? "Your words go straight out - no chance to correct them first."
              : "Your words appear in the box first, so you can fix them before sending."}{" "}
            {voiceLanguage === "auto" ? "Pick your language above if your words come out in the wrong script." : ""}
          </Text>
        </section>
      )}

      <section>
        <div className="side-label">Appearance</div>
        <Segmented
          block
          value={themeMode}
          onChange={setThemeMode}
          options={[
            { value: "system", label: "Auto", icon: <BulbOutlined /> },
            { value: "light", label: "Light", icon: <SunOutlined /> },
            { value: "dark", label: "Dark", icon: <MoonOutlined /> },
          ]}
        />
      </section>

      {pwa.canInstall && (
        <Button icon={<DownloadOutlined />} block onClick={pwa.install}>
          Install as an app
        </Button>
      )}
      {pwa.showIOSHint && (
        <Alert
          type="info"
          showIcon
          title="Use it like an app"
          description="Tap Share, then Add to Home Screen. It opens full screen with its own icon."
        />
      )}

      <Text type="secondary" className="small side-foot">
        Answers come from the public TTS handbook, coding knowledge or general knowledge, on free model quotas.
      </Text>
    </div>
  );
}
