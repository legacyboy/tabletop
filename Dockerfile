# Executive Tabletop D20 — API server image
# Deployable to any container host (Render, Railway, Fly.io, Docker, etc.)
# so the curl API can run remotely (not just on localhost).
#
# The API accepts an LLM provider per request (base_url/api_key/model), so a
# hosted deployment works with a DeepSeek/OpenAI/Anthropic key. Set env vars
# as defaults: OLLAMA_URL, OLLAMA_API_KEY, MODEL, PORT.

FROM node:20-alpine

WORKDIR /app

# No npm deps (zero-dependency runtime), just copy the app.
COPY package.json ./
COPY server ./server
COPY app ./app
COPY scenarios ./scenarios
COPY assets ./assets
COPY docs ./docs
COPY index.html styles.css ./

# Persisted sessions live here (volume-mount to keep across restarts).
RUN mkdir -p /app/data/sessions

ENV PORT=8000
EXPOSE 8000

CMD ["node", "server/serve.js"]
