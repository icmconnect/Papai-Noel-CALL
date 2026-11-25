# Audio Bank (Banco de Áudios Pré-Gravados)

Coloque arquivos MP3 pré-gravados neste diretório seguindo o padrão:

- `ola_vinicius.mp3`
- `ola_maria.mp3`
- `ola_joao.mp3`
- `ola_sofia.mp3`

O servidor verifica automaticamente `public/audio/bank/ola_<nome>.mp3` (em minúsculas e sem acentos) antes de chamar a API de TTS, garantindo latência próxima de 0ms na saudação inicial.
