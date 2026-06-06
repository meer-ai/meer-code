import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("031_RehomeCodexModelSelectionsToMeer", (it) => {
  it.effect("rewrites persisted Codex model selections to Meer", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 30 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-codex',
            'Codex project',
            '/tmp/codex',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            '[]',
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            NULL
          ),
          (
            'project-claude',
            'Claude project',
            '/tmp/claude',
            '{"instanceId":"claudeAgent","model":"claude-opus-4-6"}',
            '[]',
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at,
          runtime_mode,
          interaction_mode
        )
        VALUES
          (
            'thread-codex',
            'project-codex',
            'Codex thread',
            '{"provider":"codex","model":"gpt-5.4"}',
            NULL, NULL, NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            NULL, NULL, 0, 0, 0, NULL,
            'full-access', 'default'
          ),
          (
            'thread-claude',
            'project-claude',
            'Claude thread',
            '{"instanceId":"claudeAgent","model":"claude-opus-4-6"}',
            NULL, NULL, NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            NULL, NULL, 0, 0, 0, NULL,
            'full-access', 'default'
          )
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            'event-project',
            'project',
            'project-codex',
            1,
            'project.created',
            '2026-01-01T00:00:00.000Z',
            'cmd-project',
            NULL,
            'corr-project',
            'user',
            '{"projectId":"project-codex","title":"Codex project","workspaceRoot":"/tmp/codex","defaultModelSelection":{"provider":"codex","model":"gpt-5.4"},"scripts":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
            '{}'
          ),
          (
            'event-thread',
            'thread',
            'thread-codex',
            1,
            'thread.turn-start-requested',
            '2026-01-01T00:00:00.000Z',
            'cmd-thread',
            NULL,
            'corr-thread',
            'user',
            '{"threadId":"thread-codex","messageId":"message","modelSelection":{"instanceId":"codex","model":"gpt-5.4"},"runtimeMode":"full-access","interactionMode":"default","createdAt":"2026-01-01T00:00:00.000Z"}',
            '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 31 });

      const projects = yield* sql<{
        readonly projectId: string;
        readonly defaultModelSelection: string | null;
      }>`
        SELECT
          project_id AS "projectId",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        ORDER BY project_id
      `;
      assert.deepStrictEqual(
        projects.map((row) => ({
          projectId: row.projectId,
          selection: row.defaultModelSelection ? JSON.parse(row.defaultModelSelection) : null,
        })),
        [
          {
            projectId: "project-claude",
            selection: { instanceId: "claudeAgent", model: "claude-opus-4-6" },
          },
          { projectId: "project-codex", selection: { instanceId: "meer", model: "default" } },
        ],
      );

      const threads = yield* sql<{
        readonly threadId: string;
        readonly modelSelection: string;
      }>`
        SELECT
          thread_id AS "threadId",
          model_selection_json AS "modelSelection"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(
        threads.map((row) => ({
          threadId: row.threadId,
          selection: JSON.parse(row.modelSelection),
        })),
        [
          {
            threadId: "thread-claude",
            selection: { instanceId: "claudeAgent", model: "claude-opus-4-6" },
          },
          { threadId: "thread-codex", selection: { instanceId: "meer", model: "default" } },
        ],
      );

      const events = yield* sql<{
        readonly eventId: string;
        readonly payload: string;
      }>`
        SELECT event_id AS "eventId", payload_json AS "payload"
        FROM orchestration_events
        ORDER BY event_id
      `;
      const payloads = Object.fromEntries(
        events.map((row) => [row.eventId, JSON.parse(row.payload)]),
      );
      assert.deepStrictEqual(payloads["event-project"].defaultModelSelection, {
        instanceId: "meer",
        model: "default",
      });
      assert.deepStrictEqual(payloads["event-thread"].modelSelection, {
        instanceId: "meer",
        model: "default",
      });
    }),
  );
});
