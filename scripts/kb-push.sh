#!/usr/bin/env bash
# Mirrors a local folder of the knowledge base into the bucket, gs://flopbut-kb/base: uploads what
# is new or changed and deletes from the bucket what is gone from the folder. It shows what it is
# about to do and asks first. One way only: the folder wins, so pull anything written to the
# bucket from elsewhere before pushing. The bot reads the bucket as it is, so its next answer sees
# the changes.
#
#   scripts/kb-push.sh [folder]     the folder defaults to kb/
#   KB_PUSH_YES=1 scripts/kb-push.sh   no question asked
set -euo pipefail

DIR="${1:-kb}"
DEST="gs://${KB_BUCKET:-flopbut-kb}/base"
# Never uploaded: hidden files and folders (.git, .github), private/, and the base's tooling. One
# regular expression on the path inside the folder: gcloud splits a list at commas, and no
# backslashes, which it would take for escapes.
EXCLUDE='^([.]|.*/[.]|private/|.*/private/|node_modules/|.*/node_modules/|scripts/|package[.]json$|package-lock[.]json$)'

if [[ ! -f "$DIR/CARD.md" ]]; then
  echo "$DIR does not look like the knowledge base: it has no CARD.md" >&2
  exit 1
fi

# The map and the skills are built from the notes' frontmatter by the base's own script.
if [[ -f "$DIR/scripts/build-index.ts" ]]; then
  if ! (cd "$DIR" && node scripts/build-index.ts --check); then
    echo "INDEX.md or SKILLS.md is out of date or a note is broken: run npm run index in $DIR" >&2
    exit 1
  fi
fi

SYNC=(gcloud storage rsync "$DIR" "$DEST" --recursive
  --delete-unmatched-destination-objects --exclude "$EXCLUDE")

# A failed dry run (an expired login, a missing bucket) stops here, rather than reading as no change.
if ! DRY=$("${SYNC[@]}" --dry-run 2>&1); then
  echo "$DRY" >&2
  echo "Could not compare $DIR with $DEST: nothing pushed." >&2
  exit 1
fi
PLAN=$(echo "$DRY" | grep -E '^Would (copy|remove)' || true)
if [[ -z "$PLAN" ]]; then
  echo "$DEST already matches $DIR"
  exit 0
fi
echo "$PLAN" | sed -E "s#^Would copy .* to $DEST/#  upload  #; s#^Would remove $DEST/#  delete  #"
echo

if [[ "${KB_PUSH_YES:-}" != 1 ]]; then
  read -r -p "Push these changes to $DEST? [y/N] " ANSWER
  [[ "$ANSWER" == [yY]* ]] || { echo "Nothing pushed."; exit 1; }
fi

"${SYNC[@]}"
echo
echo "Done: the bot's next answer reads the new files."
