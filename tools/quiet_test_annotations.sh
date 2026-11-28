# Sourced at the start of a workflow step that runs tests. The pipeline prints ::error:: and ::warning:: lines, and the
# tests drive it into those states on purpose; GitHub would turn each one into a run annotation, so a green run would
# show fake alarms. This pauses workflow-command parsing until the step ends.
quiet_token="tests-$RANDOM$RANDOM"
echo "::stop-commands::$quiet_token"
trap 'echo "::$quiet_token::"' EXIT
