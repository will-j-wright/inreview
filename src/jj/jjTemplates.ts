export const COMMIT_JSON_TEMPLATE =
  '"{"' +
  ' ++ "\\"changeId\\":" ++ json(change_id)' +
  ' ++ ",\\"normalChangeId\\":" ++ change_id.normal_hex().escape_json()' +
  ' ++ ",\\"commitId\\":" ++ json(commit_id)' +
  ' ++ ",\\"parentCommitIds\\":[" ++ parents.map(|p| json(p.commit_id())).join(",") ++ "]"' +
  ' ++ ",\\"description\\":" ++ description.escape_json()' +
  ' ++ ",\\"subject\\":" ++ description.first_line().escape_json()' +
  ' ++ ",\\"conflict\\":" ++ conflict' +
  ' ++ ",\\"divergent\\":" ++ divergent' +
  ' ++ ",\\"root\\":" ++ root' +
  ' ++ ",\\"currentWorkingCopy\\":" ++ current_working_copy' +
  ' ++ "}\\n"';

export const OPERATION_JSON_TEMPLATE =
  '"{"' +
  ' ++ "\\"id\\":" ++ json(id)' +
  ' ++ ",\\"parentIds\\":[" ++ parents.map(|p| json(p.id())).join(",") ++ "]"' +
  ' ++ ",\\"description\\":" ++ description.escape_json()' +
  ' ++ ",\\"timestamp\\":" ++ json(time.start())' +
  ' ++ ",\\"snapshot\\":" ++ snapshot' +
  ' ++ ",\\"root\\":" ++ root' +
  ' ++ "}\\n"';

export const FILE_JSON_TEMPLATE =
  '"{"' +
  ' ++ "\\"path\\":" ++ json(path)' +
  ' ++ ",\\"fileType\\":" ++ file_type.escape_json()' +
  ' ++ ",\\"executable\\":" ++ executable' +
  ' ++ ",\\"conflict\\":" ++ conflict' +
  ' ++ "}\\n"';

export const DIFF_FILE_JSON_TEMPLATE =
  '"{"' +
  ' ++ "\\"status\\":" ++ status.escape_json()' +
  ' ++ ",\\"sourcePath\\":" ++ json(source.path())' +
  ' ++ ",\\"sourceType\\":" ++ source.file_type().escape_json()' +
  ' ++ ",\\"targetPath\\":" ++ json(target.path())' +
  ' ++ ",\\"targetType\\":" ++ target.file_type().escape_json()' +
  ' ++ "}\\n"';
