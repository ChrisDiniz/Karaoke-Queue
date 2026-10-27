# Licenciamento local do Karaoke Queue

## Token global da primeira versão

Token gerado uma única vez em **27/10/2026**, com `crypto.randomInt()` e um alfabeto de 32 caracteres maiúsculos sem `0`, `1`, `I` ou `O`:

```text
YU3ZYVR88H4DRH2KLW43
```

O mesmo token ativa qualquer instalação. Não é emitido um token por pessoa ou dispositivo. Para substituí-lo futuramente, gere um novo token somente mediante solicitação explícita, atualize o SHA-256 esperado em `src/license-service.ts` e substitua este registro. Tokens já ativados continuam persistidos como licença local nessa instalação.

## Política de avaliação

- O trial inicia na primeira execução que cria `license-state.json` nesta versão.
- A duração é exatamente 15 × 24 horas (360 horas), calculada em timestamps Unix, independente do fuso horário.
- A instalação salva `policyVersion`, `trialStartedAt` e `activated` atomicamente em `userData/license-state.json`.
- Reinicializações, sessões, meia-noite, fila vazia e atualizações não reiniciam o timestamp.
- A data do trial antigo de 30 dias e sua senha não são consultadas. Instalações existentes começam um novo período de 15 dias nesta versão.
- Estado de licença inválido/corrompido não cria outro trial silenciosamente; a inicialização falha sem alterar o SQLite de karaokê.

## Ativação e bloqueio

O Renderer consulta somente estado, expiração e tempo restante através do preload. O processo principal normaliza espaços externos e maiúsculas, valida o token de 20 caracteres e persiste `activated: true` antes de confirmar à interface. O token correto não é retornado ao Renderer, guardado no SQLite, ou registrado nos logs. A interface envia o token digitado ao processo principal pelo IPC de ativação; somente essa chamada transporta o valor submetido.

Após a expiração, leituras continuam disponíveis. O Main rejeita gravações que alterem fila, histórico, sessões, ordem, pins, congelamento ou cadência. Uma carga em modo somente leitura não cria sessão, aplica migração persistente nem altera os dados. Ativar após expirar libera as operações sem reiniciar o aplicativo.

## Limitações de segurança

Este mecanismo é uma trava local leve, sem servidor, conta, pagamento, rede, vínculo de hardware ou proteção contra alguém que edite o arquivo local, inspecione o código ou modifique o binário. O token está documentado no repositório e não deve ser tratado como segredo fortemente protegido. O arquivo `docs/licensing.md` fica fora de `build/**/*` e não é incluído na distribuição Electron atual.
