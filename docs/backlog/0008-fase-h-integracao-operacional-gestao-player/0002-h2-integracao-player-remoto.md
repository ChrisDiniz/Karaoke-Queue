# 0008/0002 — H2: Integração com Player remoto

## Identificação

- Ticket: 0008/0002
- Ticket pai: 0008 — Fase H: Integração operacional Gestão + Player
- Etapa canônica: H2
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Permitir que o Combined de Gestão controle um Player Standalone instalado em outro computador pela infraestrutura segura aprovada na Fase G.

## Escopo

- Integrar comandos operacionais autorizados da Gestão aos serviços remotos do Player.
- Receber eventos e snapshots reais do Player.
- Aplicar autenticação, pareamento, autorização, versionamento e transporte definidos na Fase G.
- Preservar o isolamento de dados e processos entre computadores.
- Manter a operação independente do Player quando desconectado, conforme contratos aprovados.
- Reutilizar serviços e contratos existentes; não criar protocolo alternativo ou duplicação desnecessária.

## Dependências

- H1 concluída.
- Infraestrutura e contratos relevantes da Fase G implementados e aprovados.
- Decisão G4 sobre autoridade/reconciliação resolvida antes de implementar fluxos que dependam dela.
- Autorização explícita do proprietário para iniciar H2.

## Decisões aprovadas

- A comunicação remota utiliza a infraestrutura e os contratos da Fase G.
- O Player pode continuar funcionando independentemente enquanto desconectado.
- O protocolo remoto não cria segunda autoridade sobre a fila da Gestão.

## Pendências

- A política de autoridade quando Player independente estabelece/restabelece conexão continua deliberadamente adiada em G4.
- Dependências específicas de segurança, pairing, reconexão e estado incerto devem estar aprovadas antes do fluxo correspondente.

## Riscos

- Comando não autorizado, estado obsoleto, falha de rede ou ACK incerto.
- Diferença entre o estado observado no Player e o confirmado pela Gestão.
- A integração pode duplicar responsabilidades já existentes na Fase G se os contratos não forem reutilizados.

## Critérios de conclusão

- Combined envia comandos autorizados e recebe eventos/snapshots correlacionados do Player remoto.
- A operação respeita as fronteiras de segurança e isolamento estabelecidas na Fase G.
- Desconexão não desativa indevidamente a operação independente do Player nem altera a fila por suposição.
- Resultados e limitações dos testes entre processos/computadores ficam registrados.

## Validação prevista

Testes reais de comunicação entre Combined e Player em computadores distintos, cobrindo pareamento/autorização, comandos, snapshots/eventos, desconexão e reconexão conforme os contratos F aprovados.

## Histórico de execução

Planejado. Nenhuma implementação ou validação foi iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket H1 — Gestão operacional](0001-h1-gestao-operacional.md)
- [Ticket G3 — Comandos e sincronização](../0007-fase-g-comunicacao-remota-segura/0003-g3-comandos-eventos-sincronizacao.md)
- [Ticket G4 — Reconexão e recuperação](../0007-fase-g-comunicacao-remota-segura/0004-g4-reconexao-recuperacao.md)
- [Remote player architecture](../../remote-player-architecture.md)
