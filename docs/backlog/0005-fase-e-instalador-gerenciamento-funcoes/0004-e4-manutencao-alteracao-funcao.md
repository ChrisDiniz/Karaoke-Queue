# 0005/0004 — E4: Manutenção e alteração de função

## Identificação

- Ticket: 0005/0004
- Ticket pai: 0005 — Fase E: Instalador e gerenciamento de funções
- Etapa canônica: E4
- Status: Planejado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Permitir alteração posterior da função pelo fluxo de manutenção do instalador, sem interromper processos de forma insegura nem destruir dados silenciosamente.

## Escopo

- Detectar instalação existente quando o instalador for executado novamente.
- Oferecer “Alterar função” no fluxo de manutenção.
- Exigir encerramento seguro do aplicativo e impedir alteração insegura com processos ativos.
- Aplicar a exclusividade definida em E3 e implementada em E1.
- Atualizar função, identidade e atalhos conforme E1/E2.
- Preservar bancos, configurações, perfis e dados.
- Tratar falhas parciais segundo a estratégia aprovada.
- Avaliar integração com “Alterar” em Programas e Recursos sem torná-la requisito obrigatório inicial.

## Dependências

- E3: estratégia de instalação, exclusividade, preservação e recuperação aprovada.
- E1: instalador, função e exclusividade funcionais.
- E2: identidade e atalhos por função.
- Autorização explícita do proprietário para iniciar E4.

## Atividades planejadas

- Implementar detecção e fluxo de manutenção do instalador.
- Coordenar encerramento/estado dos processos antes da mudança.
- Aplicar nova função e atalhos sem criar instalações paralelas.
- Preservar dados e oferecer recuperação segura em falha parcial, conforme E3.
- Validar troca de função em Windows nativo com perfis e bancos isolados.

## Critérios de conclusão

- Reexecutar o instalador detecta a instalação e permite alterar a função.
- A troca não prossegue enquanto houver processo incompatível ativo.
- A função e os atalhos correspondem à escolha final.
- Dados/configurações são preservados; nenhuma conversão, fusão ou exclusão não aprovada ocorre.
- Falha parcial segue o fluxo de recuperação aprovado e não deixa o estado silenciosamente inconsistente.

## Validação prevista

Testar detecção, encerramento, manutenção, troca, exclusividade, atalhos e preservação após reinício em Windows nativo. Verificar os bancos/perfis antes e depois e exercitar os caminhos de falha definidos em E3.

## Decisões aprovadas

- A alteração de função ocorre pelo instalador em um fluxo de manutenção.
- O aplicativo deve ser encerrado com segurança e a alteração não pode apagar dados silenciosamente.
- Integração à opção “Alterar” de Programas e Recursos pode ser avaliada, mas não é requisito obrigatório inicial.

## Pendências

- Detalhes da interface e recuperação do fluxo dependem da estratégia E3 e do suporte NSIS/Windows auditado.
- Avaliação de Programas e Recursos permanece opcional.

## Riscos

- Processo ativo, segunda conta Windows ou atualização concorrente pode impedir uma troca segura.
- Falhas em etapas intermediárias podem deixar função, atalhos e perfis inconsistentes.
- Preservar dados não significa torná-los automaticamente acessíveis à nova função.

## Histórico

Ticket planejado e retransferido para a Fase E; não iniciado. Nenhuma implementação ou validação foi iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket E3 — Exclusividade por computador](0003-e3-exclusividade-por-computador.md)
- [Ticket E1 — Instalador único](0001-e1-instalador-unico-selecao-funcao.md)
- [Ticket E2 — Identidade visual e atalhos](0002-e2-identidade-visual-atalhos.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Windows release process](../../windows-release-process.md)
