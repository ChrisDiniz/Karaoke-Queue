# 0008/0007 — H7: Primeiro release para testes no karaokê

## Identificação

- Ticket: 0008/0007
- Ticket pai: 0008 — Fase H: Integração operacional Gestão + Player
- Etapa canônica: H7
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Preparar uma versão controlada para o proprietário testar a operação remota no estabelecimento de karaokê.

## Escopo

- Revisar evidências e critérios aprovados em H5.
- Preparar builds instaláveis de Gestão (Combined) e Reprodutor (Standalone) com o processo existente.
- Verificar funções, identidade, atalhos, instalação, compatibilidade entre versões, preservação de dados, atualização e recuperação.
- Preparar instruções mínimas de instalação/operação/recuperação, limitações conhecidas e plano de retorno quando aplicável.
- Organizar a validação presencial e registrar resultados, problemas e correções no ticket.
- Tratar a entrega como release controlado de teste operacional, não como release comercial/estável nem autorização automática de publicação.

## Dependências

- Fase D (D1–D3) concluída e aprovada, com a estrutura estabilizada e limpeza verificada.
- Fase E (E1–E5) concluída e aprovada: instalador, função selecionada, identidade, exclusividade, manutenção e atualizações/migrações.
- Fase G (G1–G6) concluída e aprovada, incluindo contratos remotos relevantes.
- H1–H6 concluídas e aprovadas; a conclusão de H6 é obrigatória antes de H7.
- H8 não é dependência de H7.
- Autorização específica do proprietário para cada ação de build, distribuição, publicação e instalação efetiva.

## Decisões aprovadas

- O primeiro release é remoto: Gestão operacional controla um Player em outro computador.
- É um release controlado para testes reais do proprietário no estabelecimento; não presume distribuição pública, release comercial ou estabilidade definitiva.
- Builds, distribuição, publicação e instalação efetiva dependem de autorização específica do proprietário.
- A reprodução local integrada ao Combined fica para H8 e não bloqueia H7.
- A UI local existente deve ser preservada, mas a ação/função local fica bloqueada ou inacessível até H8.
- Não inventar layout ou mensagem de bloqueio: mudanças visuais exigem referência Doop aprovada.

## Pendências

- Revisar resultados H5 e riscos conhecidos no momento do release.
- Confirmar versões, configurações e instruções exatas após aprovação das fases D/E/F/G e H1–H6.
- Aguardar autorização do proprietário para cada ação de build/distribuição/instalação.
- Testes presenciais ainda serão realizados pelo proprietário e não podem ser declarados concluídos antecipadamente.

## Riscos

- Incompatibilidade entre versões, dados, pairing ou configurações nos dois computadores.
- Fluxo local incompleto poder ser acionado por caminho alternativo ou parecer disponível por sua UI existente.
- Uma build de teste ser confundida com publicação comercial ou estabilidade definitiva.
- Atualização ou retorno à versão anterior afetar dados sem plano aprovado.

## Critérios de conclusão

- Critérios H5 e H6 e dependências D/E/F/G revisados com evidência suficiente e sem bloqueadores não aceitos.
- Builds correspondentes às funções testadas são compatíveis e preservam dados conforme as aprovações existentes.
- Instruções, limitações e recuperação estão registradas.
- Reprodução remota está disponível para o escopo aprovado; reprodução local integrada permanece inacessível sem remover sua UI existente.
- A entrega e a instalação ocorreram somente após autorização específica.
- Resultados do proprietário no estabelecimento são registrados sem pressupor aprovação antes dos testes.

## Validação prevista

Verificar pacote e configuração das duas funções, atalhos, atualização/dados, instalação em computadores de teste e operação remota conforme H5. O proprietário conduz os testes reais no karaokê; documentar resultados, incidentes, evidências e correções antes de qualquer decisão sobre H8 ou distribuição posterior.

## Histórico de execução

Ticket novo, planejado e não iniciado. Nenhuma build, publicação, distribuição ou validação no estabelecimento ocorreu nesta reorganização documental.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket H5 — Validação operacional remota](0005-h5-validacao-operacional-remota.md)
- [Windows release process](../../windows-release-process.md)
- [Windows native testing](../../windows-native-testing.md)
- [Remote player architecture](../../remote-player-architecture.md)
