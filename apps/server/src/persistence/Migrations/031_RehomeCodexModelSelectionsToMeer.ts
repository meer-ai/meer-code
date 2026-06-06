import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const MEER_MODEL_SELECTION = '{"instanceId":"meer","model":"default"}';

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET model_selection_json = json(${MEER_MODEL_SELECTION})
    WHERE model_selection_json IS NOT NULL
      AND (
        json_extract(model_selection_json, '$.instanceId') = 'codex'
        OR json_extract(model_selection_json, '$.provider') = 'codex'
      )
  `;

  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = json(${MEER_MODEL_SELECTION})
    WHERE default_model_selection_json IS NOT NULL
      AND (
        json_extract(default_model_selection_json, '$.instanceId') = 'codex'
        OR json_extract(default_model_selection_json, '$.provider') = 'codex'
      )
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.modelSelection',
      json(${MEER_MODEL_SELECTION})
    )
    WHERE event_type IN (
      'thread.created',
      'thread.meta-updated',
      'thread.turn-start-requested'
    )
      AND (
        json_extract(payload_json, '$.modelSelection.instanceId') = 'codex'
        OR json_extract(payload_json, '$.modelSelection.provider') = 'codex'
      )
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.defaultModelSelection',
      json(${MEER_MODEL_SELECTION})
    )
    WHERE event_type IN ('project.created', 'project.meta-updated')
      AND (
        json_extract(payload_json, '$.defaultModelSelection.instanceId') = 'codex'
        OR json_extract(payload_json, '$.defaultModelSelection.provider') = 'codex'
      )
  `;
});
