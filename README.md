# Norium WhatsApp API

API privada baseada em `@open-wa/wa-automate`, criada para substituir o gateway terceirizado do Norium sem expor a sessão do WhatsApp ao navegador.

## Segurança

- TLS obrigatório no Azure Container Apps.
- Chaves diferentes para o Norium e para a superfície administrativa completa.
- Comparação constante das credenciais, limites de requisição e envio, validação de payload e teto de mídia.
- Eventos assinados com HMAC-SHA256, timestamp e identificador único.
- Outbox persistente com novas tentativas; sessões e fila ficam em Azure Files.
- Logs com tokens, cookies, QR e dados de sessão removidos.
- Uma única réplica, evitando corrupção ou concorrência da sessão do WhatsApp Web.
- Operações destrutivas exigem `X-Confirm-Destructive: true`.

## Superfícies

- `GET /health` e `GET /ready` — sondas da plataforma.
- `/v1/session/*` — status, QR, reconexão e logout.
- `/v1/messages/*`, `/v1/chats`, `/v1/contacts`, `/v1/groups` — operações seguras usadas pelo Norium.
- `/v1/openwa/:method` — acesso administrativo aos métodos públicos do cliente OpenWA. Corpo: `{ "args": [] }`.
- `/v1/compat/*` — compatibilidade privada com o contrato de gateway já usado pelo Norium.

Autentique com `Authorization: Bearer <chave>` ou `X-API-Key`. A API administrativa exige `ADMIN_API_KEY`; as demais aceitam `NORIUM_API_KEY`.

## Execução local

```bash
npm install
npm run build
node dist/server.js
```

Copie `.env.example` para `.env` apenas no seu ambiente local. Segredos nunca devem ser commitados.

## Azure

Os templates em `infra/` criam um ACR Basic privado, Azure Files cifrado em
repouso, um Container Apps Environment e a API com exatamente uma réplica. O
deploy usa uma imagem identificada pelo SHA do commit; QR, sessão e outbox são
mantidos em `/data` mesmo quando a revisão é substituída.

O pipeline de produção é iniciado pelo repositório do Norium porque a identidade
OIDC já autorizada na assinatura está vinculada a ele. O código, a imagem e toda
a infraestrutura desta API permanecem neste repositório separado.

## Aviso

OpenWA automatiza o WhatsApp Web e não é uma API oficial da Meta. Mudanças ou mecanismos antiautomação do WhatsApp podem interromper a sessão ou restringir a conta. Use um número dedicado, limite o volume e respeite consentimento, opt-out e as regras aplicáveis.
