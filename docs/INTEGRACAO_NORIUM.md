# Contrato interno Norium - WhatsApp

Esta API e um servico privado. O navegador chama somente o backend autenticado do Norium; nunca chama estes endpoints diretamente e nunca recebe chaves, assinatura ou identificador interno de sessao.

## Identidade e isolamento

Em toda rota `/v1` o backend envia `Authorization: Bearer`, `X-Norium-User-Id`, `X-Norium-Session-Id` e `X-Norium-Session-Signature`. A assinatura e `HMAC-SHA256(NORIUM_API_KEY, userId + "\n" + sessionId)`. O backend deriva o `sessionId` do usuario autenticado; valores enviados pelo frontend sao ignorados.

Cada contexto validado recebe um worker OpenWA independente, um diretorio de sessao independente e eventos com `userId` e `sessionId` imutaveis. Um mesmo `sessionId` nao pode ser reutilizado por outro usuario.

## Sessao

- `GET /v1/session/status`: retorna `starting`, `qr`, `connected`, `disconnected` ou `error`.
- `GET /v1/session/qr`: retorna o QR somente enquanto o estado e `qr`; depois da conexao retorna `qr: null`.
- `POST /v1/session/reconnect`: inicia ou reinicia apenas a sessao autenticada.
- `POST /v1/session/logout`: encerra somente a sessao autenticada e exige `X-Confirm-Destructive: true`.

O Norium nao lista conversas antes de `connected`.

## Conversas, mensagens e midia

- `GET /v1/chats`: catalogo leve das conversas da sessao.
- `GET /v1/chats/:id/messages?before=<timestamp>&limit=50`: historico paginado.
- `POST /v1/chats/:id/read` e `DELETE /v1/chats/:id`: leitura e exclusao real.
- `GET /v1/messages/:id/media`: baixa a midia pela sessao autenticada.
- `POST /v1/messages/text` e `POST /v1/messages/media`: envio real.
- `POST /v1/messages/forward` e `DELETE /v1/messages/:id`: encaminhamento e exclusao real.
- `GET /v1/contacts`, `GET /v1/contacts/:id/profile-picture`, `GET /v1/groups/:id` e `POST /v1/groups`: contatos, fotos e grupos.

## Eventos em tempo real

Cada evento e colocado em outbox persistente e enviado ao webhook do Norium com HMAC, timestamp e ID antirreplay. O envelope inclui o usuario e a sessao proprietarios. O backend rejeita qualquer combinacao divergente e publica o evento apenas no WebSocket autenticado daquele usuario.

## Operacao

`GET /health` e `GET /ready` nao revelam usuarios, numeros, QR ou IDs de sessao. Logs ocultam chaves, assinatura, cookies e QR. A producao usa uma replica para impedir concorrencia sobre os perfis persistidos e permite ate oito sessoes simultaneas no recurso atual.
