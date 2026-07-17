import { useSettings, pauseUntil } from "../../state/settings.js";
import { Button, Card, EmptyState, Muted, SectionTitle, StatusPill } from "../ui.js";
import { PET_STATE_DESCRIPTIONS } from "../../pet/renderer.js";
import type { PetStateName } from "../../pet/machine.js";

export function Home({ petState }: { petState: PetStateName }) {
  const { settings, update } = useSettings();
  const paused = settings.observation_paused;

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-center justify-between">
          <SectionTitle>Observation</SectionTitle>
          <StatusPill tone={paused ? "muted" : "success"}>
            {paused ? "Paused" : "Observing"}
          </StatusPill>
        </div>
        <Muted>{PET_STATE_DESCRIPTIONS[petState]}</Muted>
        {!paused && settings.allowlist_domains.length > 0 && (
          <Muted>
            Watching {settings.allowlist_domains.length} allowed{" "}
            {settings.allowlist_domains.length === 1 ? "site" : "sites"} · browser category
          </Muted>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {paused ? (
            <Button onClick={() => void update({ observation_paused: false, paused_until: null })}>
              Resume observation
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                onClick={() => void update({ observation_paused: true, ...pauseUntil(15) })}
              >
                Pause 15 min
              </Button>
              <Button
                variant="secondary"
                onClick={() => void update({ observation_paused: true, ...pauseUntil(60) })}
              >
                Pause 1 hour
              </Button>
              <Button
                variant="secondary"
                onClick={() => void update({ observation_paused: true, ...pauseUntil("tomorrow") })}
              >
                Until tomorrow
              </Button>
            </>
          )}
        </div>
      </Card>

      <Card>
        <SectionTitle>Today's verified time saved</SectionTitle>
        <p className="text-2xl font-semibold tabular-nums">0 min</p>
        <Muted>Verified savings appear after your first approved agent run.</Muted>
      </Card>

      <EmptyState
        title="No suggestions yet"
        body="Once Maman has seen a workflow repeat at least three times across two days, a suggestion with full evidence will appear here."
      />
    </div>
  );
}
