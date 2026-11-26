# Arquitetura e Documentação Técnica — Chamada Mágica do Papai Noel

> **Documento sincronizado com o código atual do repositório em 26/11/2026.**
> Descreve fielmente a arquitetura real em produção/desenvolvimento, rotas, variáveis de ambiente, máquina de estados de chamada, pipeline de áudio/voz (Gemini TTS + DSP), sistema de pagamentos Asaas, indicações, banco de vozes em disco e painel administrativo (`/admin`).

---

## 1. Visão Geral da Arquitetura

O projeto é uma aplicação full-stack **React 19 + TypeScript + Tailwind CSS v4** servida por um backend **Node.js + Express** (`server.ts`) com suporte a **PWA** (`vite-plugin-pwa`, Service Worker customizado em `src/sw.js` compatível com `Range` requests de vídeo MP4 no iOS Safari).

### Principais Capacidades
1. **Chamadas de Vídeo Personalizadas (4 planos de vídeo: `15s`, `30s`, `60s`, `familia`)**:
   - Vídeo em tela cheia 9:16 com troca suave de estados (`hello`, `talking`, `listening`, `goodbye`), câmera frontal do usuário em PIP com recuperação automática de faixa (`ended`/`muted`) e cronômetro wall-clock iniciado ao atender.
   - Roteiro de **3 atos pré-gerados em paralelo** no `POST /api/santa/greeting` (`greeting`, `bridge` para planos ≥ 30s, `farewell` ≤ 90 chars) e conversa por voz ao vivo nos planos interativos (`60s` e `familia`) via Web Speech API + fallback `MediaRecorder` -> `POST /api/santa/reply`.
2. **Plano Isca "Áudio Mágico" (`audio` — R$ 4,90)**:
   - Gera mensagem de voz personalizada do Papai Noel (`POST /api/santa/audio`) entregue por link único (`/?audio=...&token=...`), com card visual em PNG (Canvas `1080×1350`), download do áudio/pacote, compartilhamento no WhatsApp e auto-retry silencioso em background (3x a cada 20s) em caso de erro temporário de cota.
3. **Gate de Pagamento Asaas + Tokens HMAC-SHA256**:
   - Checkout via links Asaas por plano (`ASAAS_LINK_*`), confirmação dupla (`POST /api/pay/confirm` consultando API Asaas + cache de webhook), webhook assinado (`POST /api/pay/asaas`), validação de token (`POST /api/pay/validate-token`) e bloqueio HTTP `402` sem direito pago válido.
4. **Cadastro de Pais, "Minhas Magias" e Programa de Indicações (5 -> 1)**:
   - Registro pós-pagamento (`POST /api/parents/register`) com sessão assinada em cookie `HttpOnly`/`SameSite=None`/`Partitioned` (`santa_parent_session`), envio de digest diário para o dono via Resend (`RESEND_API_KEY`), rastreamento de conversões por `?ref=<parentId>` (5 indicações pagas = 1 crédito grátis de chamada `60s`) e tela **Minhas Magias**.
5. **Banco de Vozes Pré-Gerado + Painel Admin (`/admin`)**:
   - Lista `TOP_NAMES` com 120 nomes brasileiros populares (60 meninos + 60 meninas deduplicados por slug) + 6 clipes genéricos gravados em `public/audio/bank/*.wav` via `POST /api/admin/bank/generate` e servidos com latência ~0ms.
   - Painel administrativo somente leitura em `/admin` (protegido por `ADMIN_TOKEN`) com 4 tabelas operacionais e exportação CSV segura.

---

## 2. Estrutura de Pastas e Arquivos

```text
/
├── .env.example                    # Modelo de variáveis de ambiente base
├── .gitignore                      # Regras de exclusão Git
├── ARQUITETURA_E_DOCUMENTACAO.md   # Este documento técnico
├── bun.lock                        # Lockfile presente no ambiente
├── index.html                      # HTML raiz (pt-BR, SEO, Open Graph, Twitter Card, JSON-LD Product+5 Offers e FAQPage)
├── metadata.json                   # Metadados do app, permissões (câmera/microfone) e MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API
├── package.json                    # Scripts (dev, start, build, preview, clean, lint) e dependências
├── server.ts                       # Backend Express + Vite dev middleware + Gemini Text/TTS + Asaas + Parents/Ref + Admin
├── tsconfig.json                   # TypeScript (ES2022, ESNext, bundler, noEmit)
├── vite.config.ts                  # Vite 8 + React + Tailwind v4 + VitePWA (injectManifest)
│
├── public/                         # Assets estáticos
│   ├── _redirects                  # Fallback SPA (/* -> /index.html 200)
│   ├── apple-touch-icon.png        # Ícone 180x180 iOS
│   ├── documentacao-projeto.md     # Cópia estática auxiliar de documentação
│   ├── icon.svg                    # Ícone vetorial SVG
│   ├── llms.txt                    # Resumo GEO/LLM (servido dinamicamente com APP_URL em /llms.txt)
│   ├── manifest.json               # Manifesto PWA (standalone, portrait, pt-BR)
│   ├── pwa-192x192.png             # Ícone PWA 192x192
│   ├── pwa-512x512.png             # Ícone PWA 512x512
│   ├── pwa-maskable-512x512.png    # Ícone PWA maskable 512x512
│   ├── robots.txt                  # Fallback estático (sobrescrito dinamicamente pela rota /robots.txt em server.ts)
│   ├── santa-avatar.png            # Avatar do Papai Noel (Home, Chamada Recebida, OG/Twitter e card PNG)
│   ├── sitemap.xml                 # Sitemap XML (sobrescrito dinamicamente em /sitemap.xml)
│   │
│   ├── audio/
│   │   └── bank/                   # Banco de áudios em disco (/audio/bank/ola_<slug>.wav|mp3 e clipes genéricos)
│   │       └── README.md           # Instruções do diretório
│   │
│   └── videos/                     # Os 4 vídeos MP4 da chamada e home
│       ├── santa-hello.mp4         # Fase inicial de saudação (até 3,5s)
│       ├── santa-listening.mp4     # Vídeo de escuta (também fundo da HomeScreen)
│       ├── santa-talking.mp4       # Vídeo de fala (loop com playbackRate = 1.05)
│       └── santa-goodbye.mp4       # Vídeo de despedida (ativado em T-6s ou T-3s)
│
└── src/                            # Frontend React 19 + TypeScript + Tailwind v4
    ├── App.tsx                     # Orquestrador de telas, rotas (/admin, /debug-call, /debug-tts), checkout gate e sessão de pais
    ├── index.css                   # Tailwind CSS v4 (@import "tailwindcss";), animações e safe-area iOS
    ├── main.tsx                    # Entrypoint React + registro PWA
    ├── sw.js                       # Service Worker customizado (cache estático + pass-through de Range no iOS)
    ├── types.ts                    # PlanId, PLANS (5 planos), CallConfig, AdminOverviewResponse, AudioBankFileItem, etc.
    │
    ├── components/
    │   ├── AdminScreen.tsx         # Painel /admin somente leitura (login ADMIN_TOKEN, 4 tabelas e Exportar CSV)
    │   ├── AudioMagicScreen.tsx    # Tela do plano Áudio Mágico (player, download pacote áudio+PNG Canvas, WhatsApp, auto-retry 20s)
    │   ├── DebugPanel.tsx          # Estúdio de Voz (4 prebuilt + Voice Design) e gerador "Banco de Vozes"
    │   ├── HomeScreen.tsx          # Página inicial, Lista dos Bonzinhos, portão matemático dos pais e FAQ acessível
    │   ├── IncomingCallScreen.tsx  # Tela de chamada recebida com toque Web Audio, vibração e Atender/Recusar
    │   ├── OfflineIndicator.tsx    # Aviso de modo offline
    │   ├── PWAInstallButton.tsx    # Instalação PWA (Android + guia iOS)
    │   ├── ParentPanel.tsx         # Painel dos pais (5 planos, checkout Asaas, countdown CTA 10s, formulário e Link Mágico)
    │   ├── SnowfallBackground.tsx  # Neve decorativa em CSS
    │   └── VideoCallScreen.tsx     # Chamada de vídeo 9:16 (wall-clock, 3 atos, gate EMA+histerese, mic hold 10s, PIP)
    │
    ├── hooks/
    │   ├── useOnlineStatus.ts      # Hook de conectividade
    │   └── usePWAInstall.ts        # Hook de instalação PWA
    │
    └── utils/
        └── audioEngine.ts          # Motor AudioContext + DSP (HP/EQ/Compressor) + HTMLAudio fallback
```

---

## 3. Variáveis de Ambiente (`server.ts`)

| Variável | Obrigatória | Descrição |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Sim (ou `GEMINI_API_KEYS`) | Chave da API Gemini para texto, transcrição e TTS. |
| `GEMINI_API_KEYS` | Opcional | Lista separada por vírgula para rotação round-robin entre chaves. |
| `GEMINI_TTS_MODEL` | Opcional | Padrão `'gemini-3.8-flash-tts'`. Aceita `'gemini-3.8-flash-tts'` ou `'gemini-3.8-flash-lite-tts'`. |
| `GEMINI_TTS_VOICE` | Opcional | Voz padrão `'Algenib'`. Aceita `'Algenib'`, `'Gacrux'`, `'Charon'`, `'Alnilam'` ou Voice Design ID (`/^voice_[A-Za-z0-9_-]+$/`). |
| `CLOUDFLARE_GATEWAY_URL` | Opcional | URL base de AI Gateway para chamadas Gemini (SDK e REST `v1beta`). |
| `APP_URL` | Recomendada | URL pública do serviço (usada em links de compartilhamento, `sitemap.xml`, `robots.txt`, `llms.txt` e meta tags). |
| `SECRET` | Recomendada em prod | Segredo HMAC-SHA256 dos tokens de direito e cookie `santa_parent_session`. Se omitido, usa segredo efêmero por processo. |
| `ADMIN_TOKEN` | Para `/admin` e Banco de Vozes | Token exigido no header `x-admin-token` para `/api/admin/overview`, `/api/admin/bank/list` e `/api/admin/bank/generate`. Sem ele configurado, essas rotas retornam `401`. |
| `ASAAS_API_KEY` | Para confirmação API Asaas | Chave da API Asaas (`access_token`) usada em `/api/pay/confirm` e `/api/admin/overview`. |
| `ASAAS_ENV` / `ASAAS_API_URL` | Opcional | `sandbox` usa `https://api-sandbox.asaas.com/v3`; padrão é `https://api.asaas.com/v3` (ou URL customizada via `ASAAS_API_URL`). |
| `ASAAS_WEBHOOK_TOKEN` | Para webhook Asaas | Token/segredo para validar `asaas-access-token` ou assinatura HMAC `x-asaas-signature` em `POST /api/pay/asaas` (faz fallback para `SECRET` se omitido). |
| `ASAAS_LINK_15S`, `ASAAS_LINK_30S`, `ASAAS_LINK_60S`, `ASAAS_LINK_FAMILIA`, `ASAAS_LINK_AUDIO` | Para checkout Asaas | URLs de checkout Asaas retornadas em `GET /api/pay/config`. |
| `RESEND_API_KEY`, `OWNER_EMAIL`, `RESEND_FROM_EMAIL` | Opcional | Configuração do envio do digest diário de pais cadastrados via Resend. |
| `PORT` / `NODE_ENV` | Runtime | Porta HTTP (padrão `3000`) e modo `production` vs dev. |

---

## 4. Pipeline de Voz, Áudio e Banco em Disco

### 4.1. Backend Gemini Text & TTS (`server.ts`)
- **Geração de Texto e Transcrição**: usa `GEMINI_TEXT_MODEL = 'gemini-2.5-flash'` (`v1beta`, `thinkingConfig: { thinkingBudget: 0 }`) com `withKeyRotationRetry` e `withTimeoutRace`:
  - Roteiro de saudação/bridge/despedida e áudio mágico: timeout `4500ms`.
  - Resposta interativa (`/api/santa/reply`): timeout `2600ms`, máximo de 14 palavras, proibição de repetir a última fala do histórico e pool de 6 respostas de fallback sem repetição.
  - Transcrição de áudio (`inlineData` quando Web Speech falha, ex. iOS Safari): timeout `4000ms`.
- **TTS Neural (`synthesizeSantaVoice`)**:
  - Modelo padrão para saudação, ponte, despedida, áudio mágico e geração em lote: **`gemini-3.8-flash-tts`**.
  - Modelo para turnos interativos (`/api/santa/reply`): **`gemini-3.8-flash-lite-tts`** (menor latência e bucket de cota separado).
  - Sanitização via `prepareSantaSpeechScript(text, 180)` (90 chars em despedidas; 160 chars em replies), removendo rótulos, colchetes, markdown e "Ho ho ho" escrito.
  - Adiciona a tag inline `<chuckle> ` no `directedText` e envia `SANTA_STYLE` no campo `speechMetadata: { style }` por part:
    - `SANTA_STYLE = 'Caloroso e acolhedor, ritmo lento e sem pressa, sorriso audível, ternura de avô, respiração calma.'`
    - Se a versão/validação do SDK rejeitar `speechMetadata`, faz fallback automático para REST `v1beta` com `speech_metadata: { style }` por part (e fallback final sem `speech_metadata` mantendo `<chuckle>` para resiliência).
  - **Conversão PCM -> WAV (`ensurePlayableAudio`)**: se o modelo retornar `audio/l16`, `audio/pcm` ou `audio/raw`, envolve automaticamente com cabeçalho RIFF WAV de 44 bytes (mono, 16-bit, sample rate extraído ou `24000 Hz`).
  - **Cancelamento por desconexão (`createRequestAbortController`)**: escuta `req.on('close')`, `req.on('aborted')` e `res.on('close')` em `/api/santa/greeting`, `/api/santa/reply`, `/api/santa/audio` e `/api/admin/bank/generate` para abortar imediatamente chamadas TTS em andamento e economizar cota.

### 4.2. Banco de Vozes em Disco (`public/audio/bank/`)
- `lookupDiskAudioBank(childName)` verifica em disco na ordem: `ola_<slug>.wav`, `<slug>.wav`, `ola_<slug>.mp3`, `<slug>.mp3` (`slug = normalizeAudioBankSlug(childName)`).
- `TOP_NAMES` contém **120 nomes únicos** (60 meninos + 60 meninas baseados nos mais comuns no Brasil/IBGE, incluindo `Kauan`, `César` e `Agatha`, deduplicados por slug).
- `POST /api/admin/bank/generate` (protegido por `x-admin-token`):
  - Gera 6 clipes genéricos (`ola_generico.wav`, `ponte_generica.wav`, `despedida_mamae.wav`, `despedida_duendes.wav`, `despedida_renas.wav`, `despedida_carta.wav`) + `ola_<slug>.wav` para cada nome em `TOP_NAMES` (saudação simples **sem** elogio/conselho, ≤ 180 chars).
  - Respeita `300ms` de intervalo entre sínteses (`abortableSleep`), confina gravação dentro de `public/audio/bank/` (`path.resolve` + `startsWith`), pula arquivos existentes válidos (> 500 bytes) a menos que `overwrite: true` seja enviado, e retorna `{ gerados, pulados, falhas, totalSolicitados, custoEstimadoBRL, files, failures }`.
- Arquivos em `public/audio/bank/` são servidos diretamente em `/audio/bank` (tanto em dev quanto em produção via `express.static`).

### 4.3. Motor de Áudio no Navegador (`src/utils/audioEngine.ts`)
- **Desbloqueio iOS/Android**: `unlockAudioContext()` deve ser chamado sincronamente no clique de **Atender** (`IncomingCallScreen` -> `App.tsx`), retomando `AudioContext` e tocando buffer silencioso de 1 sample.
- **Grafo DSP no `AudioContext`** (para `audioBase64` decodificado via `decodeAudioData`):
  ```text
  AudioBufferSourceNode
    -> highpass (80 Hz)
    -> lowshelf (190 Hz, +3.5 dB)
    -> peaking (3000 Hz, Q=1, +2.5 dB)
    -> lowpass (15500 Hz)
    -> AnalyserNode (fftSize=256, banda vocal 300Hz–3400Hz)
    -> DynamicsCompressorNode (threshold=-18, knee=20, ratio=4, attack=4ms, release=180ms)
    -> dryGain (1.0)
    -> ctx.destination
  ```
- **Fallback secundário**: `playWithHtmlAudioElement` usando `data:` URI com `AnalyserNode` na mesma banda vocal `300Hz–3400Hz` (`computeSpeechBandVolume`).
- **Política sem voz robótica na chamada/áudio mágico**: `VideoCallScreen` e `AudioMagicScreen` passam `disableBrowserFallback: true` e `useBrowserFallback: false`, evitando acionar `window.speechSynthesis`.

---

## 5. Planos, Máquina de Estados de Chamada e Sincronia de Vídeo

### 5.1. Planos Ativos (`src/types.ts`)
| `planId` | Título | Preço | Duração (`durationSeconds`) | Interativo | Gatilho Ato 2 (`bridge`) | Gatilho Ato 3 (`farewell`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `'audio'` | Áudio Mágico (`ISCA`) | R$ 4,90 | `0s` (só áudio) | `false` | — | — |
| `'15s'` | Chamada Rápida | R$ 9,90 | `15s` | `false` | Não possui | **`T-3s`** |
| `'30s'` | Chamada Especial | R$ 19,90 | `30s` | `false` | ~40% decorrido (`12s`) | **`T-6s`** |
| `'60s'` | Conversa Mágica | R$ 29,90 | `60s` | `true` | `T-20s` (se 0 turnos) | **`T-6s`** |
| `'familia'` | Passe Família Ilimitado | R$ 39,90 | `60s` | `true` | `T-20s` (se 0 turnos) | **`T-6s`** |

### 5.2. Fluxo Temporal da Chamada (`VideoCallScreen.tsx`)
1. **Cronômetro Wall-Clock**: inicia imediatamente ao atender (`isCallActive = true`) via `Date.now()`, evitando dessincronização por throttling de timers.
2. **Ato 1 (`waiting-greeting` -> `hello` -> `conversation`)**:
   - `greetingText`, `bridgeText` (quando aplicável) e `farewellText` + seus respectivos áudios são gerados em paralelo em `POST /api/santa/greeting` durante o countdown de 10s (ou ao abrir link direto).
   - Se `preparedMedia` atrasar > `4000ms` ou falhar, tenta clipes estáticos `/audio/bank/ola_<slug>.wav|.mp3` e `/audio/bank/ola_generico.mp3|.wav`. Se nenhum existir, pausa o cronômetro, exibe card de erro com botão **"Tentar novamente"** e executa auto-retry em background após `15s`.
   - Ao iniciar a reprodução do Ato 1, `beginHelloPhase()` exibe `/videos/santa-hello.mp4` por `3500ms` (com fallback automático para `talking` se o vídeo falhar) e depois passa para `'conversation'`.
3. **Sincronia Labial com Histerese + Hold (`syncConversationVideoByVolume`)**:
   - Calcula média móvel exponencial na banda `300Hz–3400Hz`: `EMA = EMA * 0.7 + vol * 0.3`.
   - Entra em `'talking'` se `EMA > 0.08`; só volta a `'listening'` se `EMA < 0.03` **e** o último pico `> 0.08` ocorreu há mais de **`400ms`**, com transição de opacidade CSS de `500ms`.
   - O badge **"Papai Noel falando..."** é controlado pelo estado `isAudioPlaying` (`onStart`/`onEnd` do áudio), independente do gate visual da boca.
4. **Interatividade (`60s` / `familia`) e Microfone**:
   - Após cada fala do Papai Noel, agenda `SpeechRecognition` (`pt-BR`) automático e libera o botão **"Segurar para Falar"** (teto máximo de `10s` com auto-envio automático via `MIC_HOLD_MAX_MS`, usando Web Speech API com fallback `MediaRecorder` -> `POST /api/santa/reply`).
   - Possui trava de corrida para ignorar respostas atrasadas caso a chamada já tenha entrado em `'farewell'` ou `'ending'`.
5. **Ato 2 (`bridge`) & Ato 3 (`farewell`)**:
   - Ato 2 toca o áudio pré-carregado da ponte (ou `/audio/bank/ponte_generica.wav|.mp3` em fallback) no tempo previsto do plano.
   - Em `T-3s` (`15s`) ou `T-6s` (demais planos), entra em `'farewell'`, oculta o cronômetro exibindo **"Feliz Natal!"**, aborta microfone/requests pendentes, troca para `/videos/santa-goodbye.mp4` e toca imediatamente o `farewellAudioBase64` já pré-carregado (com fallback `/api/santa/farewell` -> `/audio/bank/despedida_generica.wav|.mp3` -> silêncio com badge + timeout de 2,5s).
   - Ao zerar (`remainingSeconds === 0`), aguarda o fim do áudio de despedida (com timeout de segurança de `7000ms`) e encerra limpando streams, timers e áudio.
6. **PIP Local (Câmera da Criança)**:
   - Monitora `onPlaying`, `onWaiting`, `onEnded` e eventos `ended`/`mute`/`unmute` do `MediaStreamTrack`. Exibe placeholder **"Câmera desligada"** se a faixa morrer/silenciar e solicita novo stream ao reativar.

---

## 6. Segurança, Pagamentos, Rotas de API e Painéis

### 6.1. Segurança e Validações (`server.ts`)
- **Validação de campos (`validateParentFields`)**: `childName` ≤ 60 chars, `praise` ≤ 120 chars, `advice` ≤ 120 chars; bloqueio de termos ofensivos (`INSULT_REGEXES`) e padrões de prompt injection (`INSTRUCTION_PATTERNS`).
- **Rate Limiting & Payload Caps**: `6 req/min` por IP em `/api/santa/reply` e `/api/santa/audio`; parser JSON limitado a `2mb` nessas duas rotas e `1mb` em `/api/pay/asaas`.
- **Autorização por Token HMAC (`verifyEntitlementToken`)**: todas as rotas de geração (`/api/santa/greeting`, `/api/santa/farewell`, `/api/santa/reply`, `/api/santa/audio`, `/api/parent/magic-link`) exigem token válido compatível com o plano solicitado; caso contrário retornam HTTP `402`.
- **Proteção Admin (`requireAdminToken`)**: compara `x-admin-token` com `process.env.ADMIN_TOKEN` via `crypto.timingSafeEqual` (retorna `401` se ausente, inválido ou se `ADMIN_TOKEN` não estiver definido). No frontend (`AdminScreen.tsx`), o token nunca é gravado em `localStorage` e o parâmetro `?token=` é removido da URL após autenticação.

### 6.2. Mapa Completo de Rotas Backend (`server.ts`)
| Método & Rota | Auth | Função |
| :--- | :--- | :--- |
| `GET /api/health` | Pública | Status das chaves Gemini, modelo/voz padrão ativos. |
| `GET /api/pay/config` | Pública | Retorna `appUrl` resolvido e URLs Asaas por plano. |
| `POST /api/pay/validate-token` | Token HMAC | Valida token de Link Mágico (`/?chamada=...`) ou Áudio (`/?audio=...`). |
| `POST /api/pay/confirm` | Pública (`paymentId`) | Confirma pagamento na API Asaas (`/payments/:id`) e/ou registro de webhook e emite token HMAC. |
| `POST /api/pay/asaas` | Webhook Asaas | Valida `asaas-access-token` ou `x-asaas-signature` HMAC-SHA256, registra pagamento e conta conversão `?ref=`. |
| `POST /api/parents/register` | Token HMAC | Cadastra responsável em memória, define cookie assinado `santa_parent_session` e enfileira digest. |
| `GET /api/parents/me` | Cookie `santa_parent_session` | Retorna perfil, indicações, créditos disponíveis e magias salvas. |
| `POST /api/parents/save-magic` | Cookie + Token HMAC | Salva histórico de magia gerada no perfil do responsável. |
| `POST /api/parents/redeem-credit` | Cookie `santa_parent_session` | Consome 1 crédito acumulado (a cada 5 indicações pagas) e emite token de chamada `60s`. |
| `POST /api/santa/greeting` | Token HMAC | Gera e sintetiza em paralelo os 3 atos (`greeting`, `bridge`, `farewell`) com caches. |
| `POST /api/santa/farewell` | Token HMAC | Fallback sob demanda para áudio de despedida. |
| `POST /api/santa/reply` | Token HMAC + Rate limit | Stream NDJSON de transcrição + resposta curta + áudio `gemini-3.8-flash-lite-tts`. |
| `POST /api/santa/audio` | Token HMAC (`audio`) + Rate limit | Gera Áudio Mágico personalizado (`<= 180` chars) e `shareUrl`. |
| `POST /api/parent/magic-link` | Token HMAC | Gera Link Mágico `/?chamada=...&token=...` com opcional `&ref=...`. |
| `GET /api/debug/tts`, `POST /api/debug/tts` | Dev / Debug | Testa banco em disco, cache e síntese Gemini TTS (`Algenib`, `Gacrux`, `Charon`, `Alnilam` ou `voice_*`). |
| `POST /api/admin/send-digest` | `Authorization: Bearer <SECRET>` | Dispara imediatamente o digest pendente via Resend. |
| `GET /api/admin/bank/list` | `x-admin-token` | Lista arquivos `.wav`/`.mp3` em `public/audio/bank/`. |
| `POST /api/admin/bank/generate` | `x-admin-token` | Pré-gera em lote os 6 clipes genéricos + 120 nomes (`TOP_NAMES`) em `public/audio/bank/*.wav`. |
| `GET /api/admin/overview` | `x-admin-token` | Retorna pagamentos (Asaas + locais), pais cadastrados, indicações/créditos e arquivos do bank. |
| `GET /robots.txt`, `/sitemap.xml`, `/llms.txt` | Pública | Servem diretivas SEO/GEO aplicando `APP_URL` dinamicamente. |

### 6.3. Rotas Especiais de Frontend (`src/App.tsx`)
- `/`: Fluxo principal (`HomeScreen`, `ParentPanel`, `AudioMagicScreen`, `VideoCallScreen`, `IncomingCallScreen`, `MyMagics`), além de links `?chamada=...`, `?audio=...`, `?ref=...` e retorno de pagamento `?pagamento=ok&id=...`.
- `/admin` (ou `/admin?token=...`): Renderiza `AdminScreen.tsx` com 4 tabelas somente leitura e botão **Exportar CSV** (com sanitização anti-CSV injection).
- `/debug-call`: Abre `VideoCallScreen` diretamente para diagnóstico visual/áudio local.
- `/debug-tts`: Mini tela de diagnóstico rápido de Audio Bank vs TTS por nome.
- Painel `DebugPanel.tsx` (engrenagem no topo da Home): Simulador completo de Voz/Roteiro + seção **Banco de Vozes** (com campo `ADMIN_TOKEN`, lista de arquivos, botão **Gerar banco (dev)**, cálculo de custo estimado e link direto ao faturamento Google Cloud `console.cloud.google.com/billing`).

---

## 7. Stack e Comandos (`package.json`)

- **Frontend**: `react` (`^19.0.1`), `react-dom` (`^19.0.1`), `tailwindcss` (`^4.3.3`), `@tailwindcss/vite` (`^4.3.3`), `lucide-react` (`^0.546.0`), `motion` (`^12.23.24`), `wawa-lipsync` (`^0.0.2`).
- **Backend**: `express` (`^4.21.2`), `@google/genai` (`^3.6.1`), `dotenv` (`^17.2.3`).
- **Build / Tooling**: `vite` (`^8.3.0`), `@vitejs/plugin-react` (`^6.1.1`), `vite-plugin-pwa` (`^2.0.0`), `@happyalienai/vite-plugin-llm-spider` (`^0.3.0`), `tsx` (`^4.21.0`), `typescript` (`^7.0.2`).
- **Scripts**:
  - `npm run dev` (`tsx server.ts`)
  - `npm run build` (`vite build`)
  - `npm run start` (`NODE_ENV=production tsx server.ts`)
  - `npm run lint` (`tsc --noEmit`)
