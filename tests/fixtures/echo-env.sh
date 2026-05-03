#!/bin/bash
# Prints requested env vars. Usage: echo-env.sh VAR1 VAR2 ...
# If first arg is --exit, second arg is exit code, rest are var names.
EXIT_CODE=0
if [ "$1" = "--exit" ]; then
  EXIT_CODE="$2"
  shift 2
fi
if [ "$1" = "--args" ]; then
  shift
  for arg in "$@"; do echo "ARG:$arg"; done
  exit "$EXIT_CODE"
fi
for var in "$@"; do
  echo "$var=${!var:-<unset>}"
done
exit "$EXIT_CODE"
