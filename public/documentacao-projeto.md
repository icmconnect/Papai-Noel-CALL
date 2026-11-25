# Arquitetura, Estado Atual e Dossiê Técnico — Chamada Mágica do Papai Noel

> **Documento atualizado em 25/11/2026** para auditoria técnica completa (incluindo envio para análise em IAs externas como **Qwen Chat**, Claude, etc.) sobre os **problemas atuais de qualidade/atuação de voz (TTS)** e **sincronia/transição de vídeo**.
>
> **Nota importante**: Este documento reflete **exatamente** o código e os arquivos presentes no repositório hoje — sem omissões e destacando onde estão os gargalos reais.

---

## 1. Resumo Executivo para Diagnóstico Externo (Por que Vídeo e Voz Estão com Problemas)

Se você está analisando este projeto para ajudar a resolver os problemas de **voz do Papai Noel** e **sincronia/fluidez do vídeo**, abaixo está o resumo direto do que existe hoje no código e das causas prováveis da degradação percebida:

### A. Problemas Atuais na Voz (TTS + DSP)
1. **Perda de direção teatral/prosódia no Gemini TTS**:
   - Anteriormente, instruções de atuação (`"Atue como um Papai Noel brasileiro idoso..."`) eram enviadas dentro de `parts[].text` ou via `speechMetadata` (que não é aceito pela API `@google/genai`, causando erro `Unknown name` e quebra de tipagem).
   - Para impedir que o modelo lesse as instruções em voz alta, a função `synthesizeSantaVoice` em `server.ts` passou a enviar **APENAS o texto puro da fala** em `parts: [{ text: spokenText }]`, usando `model: 'gemini-3.8-flash-tts'` e `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` (`'Algenib'` padrão).
   - **Consequência**: Sem uma forma de controlar estilo/atuação (ou prompt de estilo compatível com o modelo TTS), a voz `Algenib` / `Alnilam` lê o texto de forma relativamente neutra/locução padrão, dependendo apenas de reticências (`...`) e exclamações. Além disso, `prepareSantaSpeechScript(..., 180)` converte travessões (`—`, `–`) em vírgulas e limita a fala a 180 caracteres.
2. **Pós-processamento DSP sem Compressor/Limiter (`src/utils/audioEngine.ts`)**:
   - Na cadeia atual de `AudioContext`:
     `source` -> `lowshelf(190Hz, +3.5dB)` -> `peaking(3000Hz, +2.5dB, Q=1)` -> `lowpass(15500Hz)` -> `AnalyserNode(fftSize=256)` -> saída paralela `dryGain(0.93)` + `ConvolverNode(0.42s, wetGain=0.07)`.
   - **Possível degradação**:
     - O impulso do `ConvolverNode` é gerado sinteticamente com ruído branco filtrado (`Math.random() * 2 - 1`), o que pode soar artificial/metálico ou "de banheiro" dependendo da voz.
     - Não há `highpass` (ex: 70–80 Hz para limpar subgraves) nem `DynamicsCompressorNode` na saída após os boosts de `+3.5 dB` e `+2.5 dB`, podendo causar saturação/clipping digital ou som abafado/embolado em alto-falantes de celular.
     - Quando o `AudioContext` falha e cai no fallback `playWithHtmlAudioElement`, os filtros DSP não são aplicados (só o `AnalyserNode`), gerando timbre inconsistente.
3. **Áudio da risada inexistente no disco (`/audio/santa-laugh.mp3`)**:
   - `playSantaLaughIfAvailable()` tenta buscar `/audio/santa-laugh.mp3` antes da saudação, mas **esse arquivo NÃO existe em `public/audio/`**. O sistema sempre registra `[AudioEngine] Riso não encontrado, seguindo sem ele` e a fala já começa sem a risada inicial (e "Ho ho ho" foi removido do texto por regex).
4. **Audio Bank em disco vazio (`/public/audio/bank/`)**:
   - Não há nenhum `.mp3` pré-gerado em `public/audio/bank/`, então 100% das chamadas dependem de geração ao vivo da API de TTS.

### B. Problemas Atuais no Vídeo e Sincronia Labial (`VideoCallScreen.tsx` + `audioEngine.ts`)
1. **Troca binária sem histerese nem suavização (flickering / cortes bruscos de cabeça)**:
   - O projeto possui `wawa-lipsync` no `package.json`, **mas ela NÃO está sendo usada em nenhum lugar**.
   - Em vez disso, `audioEngine.ts` calcula a média crua de todas as bandas FFT (`sum / freqData.length / 255`) a 60fps (`requestAnimationFrame`) e envia para `VideoCallScreen.tsx`.
   - Em `VideoCallScreen.tsx`, `syncConversationVideoByVolume` troca imediatamente entre `santa-talking.mp4` e `santa-listening.mp4` usando apenas `vol > 0.05` **sem debounce, sem média móvel (EMA), sem hold mínimo de fala (ex: 300–500ms) e sem filtro nas frequências vocais (300Hz–3400Hz)**.
   - **Consequência**: A cada pausa curta entre sílabas/palavras ou respiração (especialmente porque o texto tem várias reticências `...`), o volume cai abaixo de `0.05` e o vídeo alterna freneticamente entre `talking` e `listening` a cada 100ms, gerando cortes secos na posição do rosto/cabeça do Papai Noel!
2. **Descompasso entre vídeos em loop e áudio + arquivo `santa-hello.mp4` ausente**:
   - `public/videos/` contém apenas **3 arquivos**: `santa-listening.mp4`, `santa-talking.mp4` e `santa-goodbye.mp4`.
   - **`/videos/santa-hello.mp4` NÃO existe em `public/videos/`**: ao iniciar a chamada, a tag `<video src="/videos/santa-hello.mp4">` dispara `onError`, ativa `helloVideoFailed = true` e pula a fase `hello` de 3,5s.
   - Existe um arquivo solto na raiz (`/santa-talking-1.mp4`) que não está sendo referenciado.
   - Além disso, `santa-talking.mp4` roda com `loop` contínuo e `playbackRate = 1.05` independente de quando a frase começa/termina (não há lip-sync real com o áudio, apenas troca de opacidade de `100ms`).
3. **Despedida buscada em tempo real tarde demais (`T-6s` / `T-3s`)**:
   - `triggerFarewellPhase()` só faz `POST /api/santa/farewell` (para sintetizar o áudio WAV no Gemini TTS) **quando já faltam apenas 6s (ou 3s no plano 15s)** para acabar a chamada!
   - Como a geração do TTS no servidor costuma levar de **2s a 6s** (com timeout de `14s`), o áudio da despedida frequentemente chega tarde demais (ou já com `timeLeft === 0`), disparando o timeout de segurança de `7s` ou deixando o vídeo `santa-goodbye.mp4` mudo por vários segundos antes do áudio entrar. (Idealmente, o áudio de despedida já deveria ser pré-carregado junto com a saudação ou logo no início da chamada!).

---

## 2. Árvore Completa e Atualizada de Pastas e Arquivos

```text
/
├── .env.example                    # Variáveis esperadas: GEMINI_API_KEY, GEMINI_API_KEYS, APP_URL, CLOUDFLARE_GATEWAY_URL, RESEND_API_KEY, GEMINI_TTS_VOICE
├── .gitignore                      # Regras de exclusão Git
├── ARQUITETURA_E_DOCUMENTACAO.md   # Este documento técnico na raiz do repositório
├── bun.lock                        # Lockfile presente no ambiente
├── index.html                      # HTML raiz (SEO, Open Graph, JSON-LD, fontes, meta tags PWA/iOS)
├── metadata.json                   # Metadados do app e permissões (câmera/microfone + MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API)
├── package.json                    # Dependências e scripts npm
├── santa-talking-1.mp4             # [SOLTO NA RAIZ] Vídeo auxiliar não referenciado pelo frontend
├── server.ts                       # Backend Express + Vite middleware + rotas Gemini Text/Transcribe/TTS + Audio Bank
├── tsconfig.json                   # Configuração TypeScript (ES2022, ESNext, bundler, noEmit)
├── vite.config.ts                  # Vite 8 + React + Tailwind v4 + VitePWA (injectManifest) + copy-unbundled-src-assets
│
├── public/                         # Arquivos estáticos servidos na raiz HTTP (/)
│   ├── _redirects                  # Fallback SPA (/* -> /index.html 200)
│   ├── apple-touch-icon.png        # Ícone 180x180 iOS
│   ├── documentacao-projeto.md     # Cópia pública sincronizada deste documento (/documentacao-projeto.md)
│   ├── icon.svg                    # Ícone vetorial SVG
│   ├── llms.txt                    # Resumo GEO para indexadores de IA
│   ├── manifest.json               # Manifesto PWA (standalone, portrait, pt-BR)
│   ├── pwa-192x192.png             # Ícone PWA 192x192
│   ├── pwa-512x512.png             # Ícone PWA 512x512
│   ├── pwa-maskable-512x512.png    # Ícone PWA maskable 512x512
│   ├── robots.txt                  # Regras de crawlers
│   ├── santa-avatar.png            # Imagem estática do Papai Noel (Home, Chamada Recebida e poster fallback)
│   ├── sitemap.xml                 # Sitemap XML
│   │
│   ├── audio/                      # Pasta de áudios estáticos (NOTA: santa-laugh.mp3 NÃO existe aqui atualmente)
│   │   └── bank/                   # Banco de Áudios em disco (/audio/bank/ola_<nome>.mp3)
│   │       └── README.md           # Instruções de nomenclatura (ainda sem arquivos .mp3)
│   │
│   └── videos/                     # Vídeos MP4 usados na Home e VideoCallScreen (NOTA: santa-hello.mp4 NÃO existe aqui atualmente)
│       ├── santa-goodbye.mp4       # Vídeo de despedida (ativado em T-6s ou T-3s)
│       ├── santa-listening.mp4     # Vídeo de escuta (também usado no fundo desfocado da HomeScreen)
│       └── santa-talking.mp4       # Vídeo de fala (em loop, playbackRate = 1.05)
│
└── src/                            # Código-fonte Frontend (React 19 + TypeScript + Tailwind v4)
    ├── App.tsx                     # Orquestrador principal de telas, pré-carregamento, countdown 10s, câmera frontal e rotas /debug-call e /debug-tts
    ├── index.css                   # Estilos globais Tailwind v4, animações de neve/pulso e safe-area iOS
    ├── main.tsx                    # Entrypoint React + registro do Service Worker (virtual:pwa-register)
    ├── sw.js                       # Service Worker customizado (cache estático + pass-through de headers Range para MP4 no iOS)
    ├── types.ts                    # Tipos CallConfig, PlanId, PLANS, FAREWELL_OPTIONS, PreparedCallMedia, SantaVideoState
    │
    ├── components/
    │   ├── DebugPanel.tsx          # Painel de teste de vozes Gemini TTS (Algenib, Gacrux, Charon, Alnilam) com modo estrito
    │   ├── HomeScreen.tsx          # Tela inicial com vídeo de fundo, neve, engrenagem do DebugPanel e Lista dos Bonzinhos
    │   ├── IncomingCallScreen.tsx  # Tela de chamada recebida com toque Web Audio, vibração e botões Recusar/Atender
    │   ├── OfflineIndicator.tsx    # Banner de status offline
    │   ├── PWAInstallButton.tsx    # Botão/guia de instalação PWA (Android + iOS)
    │   ├── ParentPanel.tsx         # Painel dos pais (4 planos, formulário, 4 despedidas, Link Mágico Base64URL)
    │   ├── SnowfallBackground.tsx  # Neve animada em CSS
    │   └── VideoCallScreen.tsx     # Tela da videochamada 9:16, máquina de estados do plano, mic híbrido e alternância de vídeos
    │
    ├── hooks/
    │   ├── useOnlineStatus.ts      # Hook reativo de conectividade
    │   └── usePWAInstall.ts        # Hook de detecção iOS/standalone/beforeinstallprompt
    │
    └── utils/
        └── audioEngine.ts          # Motor de áudio mobile-safe (AudioContext + DSP + HTMLAudio fallback + speechSynthesis fallback)
```

---

## 3. Fluxo Técnico Detalhado: Voz & Áudio (`server.ts` + `src/utils/audioEngine.ts`)

### 3.1. Backend (`server.ts` — 1228 linhas)
- **Modelos ativos (limpos, sem modelos experimentais/fantasmas)**:
  - **Texto & Transcrição**: `GEMINI_TEXT_MODEL = 'gemini-2.5-flash'` (`v1beta`, `thinkingConfig: { thinkingBudget: 0 }`). Timeouts: `4500ms` (greeting text), `2600ms` (reply text), `4000ms` (transcrição `inlineData`).
  - **TTS Neural**: `DEFAULT_GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts'` (aceita também `'gemini-3.8-flash-lite-tts'` via `GEMINI_TTS_MODEL` ou query/body). Timeout: `14000ms`.
  - **Vozes permitidas (`ACCEPTED_TTS_VOICES`)**: `'Algenib'` (padrão), `'Gacrux'`, `'Charon'`, `'Alnilam'`.
- **Rotação de Chaves e Resiliência**:
  - `withKeyRotationRetry`: rotaciona `GEMINI_API_KEYS` (ou usa `GEMINI_API_KEY`), com backoff `450 * attempt` para `500`/`503` e `250ms`/`1200ms` para `429`.
  - `withTimeoutRace` + `AbortController` em todas as chamadas de texto, transcrição e TTS.
- **Sanitização do Roteiro (`prepareSantaSpeechScript(text, 180)`)**:
  - Remove instruções vazadas (`"Atue como um Papai Noel..."`), colchetes, parênteses, aspas, asteriscos, rótulos de formulário (`Nome:`, `Elogio:`, `Conselho:`), e `"Ho ho ho"`.
  - Converte `;`, `—`, `–` em `, ` e limita o texto a **180 caracteres** via `truncateCleanly` (160 caracteres em `/api/santa/reply`).
- **Chamada Exata Atual do Gemini TTS (`synthesizeSantaVoice`)**:
  ```ts
  const response = await ai.models.generateContent({
    model: ttsModel, // 'gemini-3.8-flash-tts'
    contents: [{ role: 'user', parts: [{ text: spokenText }] }],
    config: {
      abortSignal: controller.signal,
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName, // 'Algenib', 'Gacrux', 'Charon', 'Alnilam'
          },
        },
      },
    },
  });
  ```
  - **Observação**: Todo uso de `speechMetadata` foi removido porque a API retornava erro de validação/tipagem. Como resultado, hoje **não há nenhuma diretriz de atuação vocal enviada ao `gemini-3.8-flash-tts`**, apenas o `spokenText` limpo.
- **Conversão de Áudio (`ensurePlayableAudio`)**:
  - Se o `mimeType` retornado for `audio/l16`, `audio/pcm` ou `audio/raw`, adiciona cabeçalho RIFF WAV de 44 bytes (mono, 16-bit, sampleRate extraído do `rate=` ou `24000 Hz` padrão) e devolve `audio/wav` em Base64.
- **Rotas de API**:
  - `GET /api/health` -> status de chaves e modelos ativos.
  - `GET /api/debug/tts` & `POST /api/debug/tts` -> teste direto de Audio Bank / Gemini TTS (`180` chars).
  - `POST /api/santa/greeting` -> gera `greetingText` + `farewellText` via JSON schema no `gemini-2.5-flash` e sintetiza **apenas** `greetingAudioBase64` (a despedida NÃO é sintetizada aqui). Cache em `greetingCache` + `audioBank`.
  - `POST /api/santa/farewell` -> sintetiza `farewellAudioBase64` sob demanda (só quando o cronômetro chega perto do fim). Cache em `farewellCache`.
  - `POST /api/santa/reply` -> stream **NDJSON** (`application/x-ndjson`, timeout global `14s`). Transcreve áudio se vier `audioBase64` (iOS fallback), gera resposta de no máximo 14 palavras, emite chunk 1 (`done: false`, texto) e chunk 2 (`done: true`, áudio WAV).
  - `POST /api/parent/magic-link` -> codifica `CallConfig` em Base64URL (`/?chamada=...`).

### 3.2. Frontend Audio Engine (`src/utils/audioEngine.ts` — 998 linhas)
- **Desbloqueio Mobile (`unlockAudioContext`)**: Chamado sincronamente no clique de "Atender" (`IncomingCallScreen` -> `App.handleAcceptIncomingCall`). Retoma `AudioContext` e toca buffer de 1 sample silencioso.
- **Ordem de execução em `playSantaAudio`**:
  1. `stopCurrentSantaVoice()` incrementa `activePlaybackGeneration`, cancela `requestAnimationFrame`, `setTimeout`, `AudioBufferSourceNode`, desconecta nós via `activeNodeCleanup`, pausa `HTMLAudioElement` e chama `speechSynthesis.cancel()`.
  2. Se `playLaughFirst === true`: chama `playSantaLaughIfAvailable()` -> `fetch('/audio/santa-laugh.mp3')`. Como o arquivo não existe em `public/audio/`, dá `warn` e segue.
  3. **Caminho Primário (`AudioContext`)**:
     - Converte Base64 -> `ArrayBuffer`, garante cabeçalho WAV via `wrapL16PcmToWav`, decodifica via `ctx.decodeAudioData`.
     - Monta grafo DSP:
       - `source` (`AudioBufferSourceNode`)
       - `lowShelfFilter`: `type = 'lowshelf'`, `frequency = 190`, `gain = 3.5`
       - `presenceFilter`: `type = 'peaking'`, `frequency = 3000`, `Q = 1`, `gain = 2.5`
       - `lowPassFilter`: `type = 'lowpass'`, `frequency = 15500`
       - `analyser`: `AnalyserNode`, `fftSize = 256`
       - Saída paralela: `dryGain` (`0.93`) -> `ctx.destination` **+** `convolver` (`getWarmRoomImpulseBuffer(ctx)`, `0.42s` estéreo gerado com ruído branco + filtro passa-baixa `0.72/0.28` e decay `(1-t)^3.2`) -> `wetGain` (`0.07`) -> `ctx.destination`.
     - Mede volume por frame (`requestAnimationFrame` -> `analyser.getByteFrequencyData(freqData)` -> média simples `sum / freqData.length / 255`) e envia para `onAudioVolume(vol)`.
     - Desconecta todos os nós (`disconnectSpeechNodes`) no `source.onended`, em erros de `start()` ou via `stopCurrentSantaVoice()`.
  4. **Caminho Secundário (`playWithHtmlAudioElement`)**:
     - Se `AudioContext.decodeAudioData` falhar, cria `new Audio('data:...')`, aguarda `canplay`, tenta conectar `MediaElementAudioSourceNode` -> `AnalyserNode` (sem os filtros EQ/Reverb!) ou usa pulso fixo `0.12` caso falhe.
  5. **Último Recurso (`speakWithBrowserFallback`)**:
     - Usa `window.speechSynthesis` (`pt-BR`, `pitch = 0.78`, `rate = 0.94`), se permitido (`!disableBrowserFallback`).

---

## 4. Fluxo Técnico Detalhado: Máquina de Estados da Chamada e Vídeo (`src/components/VideoCallScreen.tsx` + `src/App.tsx`)

### 4.1. Planos Ativos (`src/types.ts`)
| `planId` | Nome | Duração (`durationSeconds`) | Interativo (Mic) | Gatilho da Despedida (`farewellThresholdSeconds`) |
| :--- | :--- | :--- | :--- | :--- |
| `'15s'` | Chamada Rápida | `15s` | `false` | **`T-3s`** (`timeLeft <= 3`) |
| `'30s'` | Chamada Especial | `30s` | `false` | **`T-6s`** (`timeLeft <= 6`) |
| `'60s'` | Conversa Mágica | `60s` | `true` | **`T-6s`** (`timeLeft <= 6`) |
| `'familia'` | Passe Família Ilimitado | `60s` | `true` | **`T-6s`** (`timeLeft <= 6`) |

### 4.2. Pré-carregamento e Início da Chamada (`src/App.tsx`)
- Fora da chamada, `App.tsx` monta 4 `<video preload="auto" muted playsInline>` invisíveis (`1px × 1px`, `opacity-0`) para `/videos/santa-hello.mp4`, `/videos/santa-listening.mp4`, `/videos/santa-talking.mp4` e `/videos/santa-goodbye.mp4`.
- Ao clicar em **Atender** (`handleAcceptIncomingCall`), chama `unlockAudioContext()`, executa `.play()` nos 4 refs de vídeo (para liberar autoplay no iOS/Android), muda `screen` para `'call'` (`isCallActive = true`) e solicita a câmera frontal (`facingMode: 'user'`).

### 4.3. Máquina de Estados de Tempo (`CallPhase` em `VideoCallScreen.tsx` — 1410 linhas)
Estados possíveis: `'waiting-greeting' | 'hello' | 'conversation' | 'farewell' | 'ending'`.

1. **`waiting-greeting`**:
   - Ao ativar `isCallActive`, aguarda `preparedMedia` chegar (com fallback de `4000ms` caso a API atrase/falhe).
   - O cronômetro do plano (`15s`, `30s` ou `60s`) **só começa a contar** dentro de `beginCallTimeline()`, disparado no callback `onStart` do áudio da saudação.
2. **`hello` (0s até 3,5s)**:
   - Se `santa-hello.mp4` não tiver falhado (`!helloVideoFailed`), exibe `santa-hello.mp4` por `3500ms` enquanto toca o áudio da saudação.
   - **Estado real atual**: como `/public/videos/santa-hello.mp4` não existe em disco, o evento `onError` dispara, define `helloVideoFailed = true` e muda imediatamente para `'conversation'`.
3. **`conversation` (3,5s até `T-6s` ou `T-3s`)**:
   - Alterna CSS opacity (`transition-opacity duration-100 ease-linear`) entre `santa-talking.mp4` (`playbackRate = 1.05`, `loop`) e `santa-listening.mp4` (`loop`) via `syncConversationVideoByVolume(vol)`:
     - `vol > 0.05` -> `'talking'`
     - `vol <= 0.05` -> `'listening'`
   - Nos planos interativos (`60s` e `familia`), após `onEnd` do áudio do Papai Noel, ativa `SpeechRecognition` (`pt-BR`) automático + botão manual **"Segurar para Falar"** (com fallback `MediaRecorder` `audio/mp4` / `audio/webm` -> `POST /api/santa/reply`).
4. **`farewell` (`T-6s` ou `T-3s` para plano `15s`)**:
   - Interrompe microfone, `SpeechRecognition`, `MediaRecorder` e `stopCurrentSantaVoice()`.
   - Muda o vídeo visível para `/videos/santa-goodbye.mp4` (`currentTime = 0`, `.play()`, `loop`).
   - Chama `triggerFarewellPhase()` -> faz `fetch('/api/santa/farewell')` (abort em `4500ms`) e reproduz o áudio da despedida via `playSantaAudio`.
5. **`ending` (`timeLeft === 0`)**:
   - Para o `setInterval` do cronômetro.
   - Se `farewellAudioFinishedRef.current` já for `true`, chama `finishCallSafely()` imediatamente.
   - Caso contrário, aguarda o `onEnd` do áudio da despedida com um **timeout de segurança de `7000ms` (`7s`)**.
6. **Cleanup completo**:
   - `cleanupAllDevices()` limpa todos os `setInterval`, `setTimeout`, `AbortController` (`reply` e `farewell`), `SpeechRecognition`, `MediaRecorder`, `micStreamRef` tracks e chama `stopCurrentSantaVoice()`.

---

## 5. Stack e Dependências (`package.json`)

- **Frontend**: `react` (`^19.0.1`), `react-dom` (`^19.0.1`), `tailwindcss` (`^4.3.3`), `@tailwindcss/vite` (`^4.3.3`), `lucide-react` (`^0.546.0`), `motion` (`^12.23.24` — instalada, não usada no vídeo), `wawa-lipsync` (`^0.0.2` — instalada, não integrada).
- **Backend**: `express` (`^4.21.2`), `@google/genai` (`^3.6.1`), `dotenv` (`^17.2.3`).
- **Build / PWA**: `vite` (`^8.3.0`), `@vitejs/plugin-react` (`^6.1.1`), `vite-plugin-pwa` (`^2.0.0`), `tsx` (`^4.21.0`), `typescript` (`^7.0.2`).
- **Scripts**: `npm run dev` (`tsx server.ts`), `npm run build` (`vite build`), `npm run start` (`NODE_ENV=production tsx server.ts`), `npm run lint` (`tsc --noEmit`).

---

## 6. Checklist Objetivo de Perguntas / Melhorias para Levar ao Qwen Chat

Ao colar este documento em outra IA (ex.: `https://chat.qwen.ai/`) junto com os arquivos `server.ts`, `src/utils/audioEngine.ts` e `src/components/VideoCallScreen.tsx`, peça ajuda focando nestes 5 pontos concretos:

1. **Prosódia e Atuação no `gemini-3.8-flash-tts`**:
   - Como recuperar o tom caloroso/idoso/natalino de Papai Noel no `gemini-3.8-flash-tts` **sem** que o modelo leia instruções em voz alta (`parts[].text`) e **sem** usar campos inválidos como `speechMetadata`? (Ex.: escolha de voz entre `Algenib`/`Alnilam`/`Charon`/`Gacrux`, pontuação/SSML suportado se houver, ou `systemInstruction` compatível com o modelo TTS, se suportado).
2. **Qualidade da Cadeia DSP (`audioEngine.ts`)**:
   - Substituir o impulso de ruído branco do `ConvolverNode` por um tratamento mais natural, ajustar EQ/pitch/velocidade se necessário e adicionar `highpass` + `DynamicsCompressorNode` para evitar distorção e som metálico em celulares.
3. **Eliminar Flicker e Melhorar Lip-Sync no Vídeo (`VideoCallScreen.tsx`)**:
   - Aplicar histerese + média móvel (EMA) + hold mínimo (~350–500ms) + foco na banda de voz (`300Hz–3400Hz`) no `AnalyserNode` (ou usar `wawa-lipsync` / canvas crossfade suave), evitando cortes bruscos a cada micro-pausa entre palavras.
   - Fazer crossfade mais suave (`200ms–300ms`) entre vídeos em poses compatíveis ou alinhar duração de `santa-talking.mp4` / `santa-listening.mp4` (e adicionar `/public/videos/santa-hello.mp4` e `/public/audio/santa-laugh.mp3`).
4. **Pré-geração da Despedida (Eliminar Atraso em `T-6s` / `T-3s`)**:
   - Pré-gerar/cachear `farewellAudioBase64` logo após `/api/santa/greeting` (durante o countdown de 10s ou no início da chamada) para que, ao atingir `T-6s` ou `T-3s`, o áudio da despedida toque com **0ms de latência de rede** em sincronia imediata com `santa-goodbye.mp4`.
5. **Limpeza de Arquivos Órfãos**:
   - Verificar `/santa-talking-1.mp4` na raiz e a ausência de `/public/videos/santa-hello.mp4` e `/public/audio/santa-laugh.mp3`.
