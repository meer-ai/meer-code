import { definePlugin } from "@oxlint/plugins";

import noInlineSchemaCompile from "./rules/no-inline-schema-compile.js";

export default definePlugin({
  meta: {
    name: "meer",
  },
  rules: {
    "no-inline-schema-compile": noInlineSchemaCompile,
  },
});
