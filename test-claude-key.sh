#!/usr/bin/env bash
set -u

API_KEY="${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-}}"
BASE_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
MODEL="${ANTHROPIC_MODEL:-claude-sonnet-4-6}"
AUTH_STYLE="${ANTHROPIC_AUTH_STYLE:-x-api-key}"

if [[ -z "$API_KEY" ]]; then
  echo "Error: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN first."
  exit 1
fi

BASE_URL="${BASE_URL%/}"

if [[ "$BASE_URL" == */v1 ]]; then
  ENDPOINT="$BASE_URL/messages"
else
  ENDPOINT="$BASE_URL/v1/messages"
fi

HEADERS=(
  -H "content-type: application/json"
  -H "anthropic-version: 2023-06-01"
)

case "$AUTH_STYLE" in
  x-api-key)
    HEADERS+=(-H "x-api-key: $API_KEY")
    ;;
  bearer)
    HEADERS+=(-H "Authorization: Bearer $API_KEY")
    ;;
  both)
    HEADERS+=(
      -H "x-api-key: $API_KEY"
      -H "Authorization: Bearer $API_KEY"
    )
    ;;
  *)
    echo "Error: ANTHROPIC_AUTH_STYLE must be x-api-key, bearer, or both."
    exit 1
    ;;
esac

RESPONSE_FILE="$(mktemp)"
trap 'rm -f "$RESPONSE_FILE"' EXIT

HTTP_STATUS="$(
  curl --silent --show-error \
    --output "$RESPONSE_FILE" \
    --write-out "%{http_code}" \
    --request POST "$ENDPOINT" \
    "${HEADERS[@]}" \
    --data "{
      \"model\": \"$MODEL\",
      \"max_tokens\": 16,
      \"messages\": [
        {
          \"role\": \"user\",
          \"content\": \"Reply with exactly: KEY_OK\"
        }
      ]
    }"
)"

echo "Endpoint: $ENDPOINT"
echo "Model:    $MODEL"
echo "HTTP:     $HTTP_STATUS"
echo

if [[ "$HTTP_STATUS" == "200" ]]; then
  echo "Success: the key, endpoint, and model are working."
else
  echo "Test failed. Server response:"
fi

if command -v jq >/dev/null 2>&1; then
  jq . "$RESPONSE_FILE"
else
  command cat "$RESPONSE_FILE"
  echo
fi
