# Roadmap de migração — Standalone e Combined

## Objetivo

Registrar a migração do Player Only legado para o **Player Only (Standalone)** de tela única e a consolidação das funções operacionais atuais no **Tudo em um (Combined)**. Este roadmap é subordinado à especificação funcional V1 em [`standalone-one-screen-player.md`](standalone-one-screen-player.md); não a substitui nem autoriza funcionalidades adicionais.

> **AVISO DE TRANSIÇÃO**
>
> O Karaoke Queue está migrando para uma arquitetura com dois modos de operação: Player Only (Standalone) e Tudo em um (Combined). A implementação anterior do Player Only permanece temporariamente no repositório. Depois da validação funcional, visual e audiovisual do novo Standalone e da aprovação do proprietário, a UI, as regras e os testes exclusivamente antigos serão revisados e removidos somente quando comprovadamente obsoletos. Serviços técnicos compartilhados serão preservados e reutilizados quando apropriado.

O código ainda pode expor três valores de modo. Isso é compatibilidade transitória, não o produto-alvo. A seleção de modos não faz parte da A1 e não deve ser alterada antes da Fase E.

## Estado do checkpoint pré-migração

- **Branch base:** `feature/remote-player-lan-integration`.
- **HEAD pré-checkpoint:** `3f7d8597e51c52b8ec8990a119193a5c84dadddb`.
- A implementação das fases 5F-B3/B4/B5 e seus testes locais são preservados pelo checkpoint A1.
- A validação automatizada Linux e Windows da 5F-B5 foi registrada; a validação audiovisual manual no Windows continua pendente do proprietário. O checkpoint não representa aprovação audiovisual.
- A especificação V1 é a fonte funcional, foi fornecida no working tree e deve permanecer byte a byte inalterada até autorização explícita.

## Arquitetura-alvo

```text
Infraestrutura compartilhada
           ↓
Orquestração específica do modo
           ↓
Interface específica do modo
```

- **Standalone:** uma sequência local e independente, conforme a V1; não depende da fila inteligente, das sessões, do histórico nem do `AppState` Controller.
- **Combined:** preserva `KaraokeApplication`, `StateRepository`, SQLite operacional e as regras atuais do Controlador; controla reprodução local ou, em etapa própria, um Player remoto.
- **Compartilhado quando tecnicamente adequado:** engine Chromium/Electron, `PlayerPlaybackService`, resolução/validação da mídia, biblioteca, serviços de catálogo se aprovados no escopo V1, recovery, IPC seguro e gerenciamento de recursos/janelas.
- Reutilizar um serviço técnico não torna compartilhada a semântica de uma fila nem obriga reutilizar a interface antiga.

## Auditoria A1 — fatos que orientam a migração

### Infraestrutura de reprodução candidata à reutilização

- `src/player-playback-service.ts` mantém o estado e as tentativas de playback no Main, valida códigos, serializa transições e correlaciona observações do host.
- `src/chromium-playback-host.ts`, `player-preload.ts` e `src/player-playback-renderer.ts` implementam o limite Main/Preload/Renderer do host Chromium; `src/player-media-protocol.ts` fornece acesso local por capacidades opacas, sem passar caminhos pela UI.
- `src/video-library.ts`, `src/video-library-configuration.ts` e `src/video-library-service.ts` separam parser/configuração/indexação/lookup. O serviço de biblioteca é Main-side; caminhos absolutos não são contratos da UI.
- `src/player-playback-recovery-store.ts` e `src/player-playback-recovery.ts` fornecem persistência e coordenação de recovery sem criar histórico Controller.
- `src/player-video-window.ts` administra o host e a janela de vídeo da implementação atual. Sua reutilização futura depende das necessidades da nova interface e deve permanecer separada da orquestração.
- `src/music-catalog.ts`, `src/music-catalog-service.ts` e `database.ts` oferecem parser e persistência CSV. A interface e as opções do Standalone devem seguir a V1 aprovada pelo proprietário, não o fluxo antigo por inferência.

### Orquestração e UI legadas

- `src/manual-playback-service.ts` é o orquestrador da sequência antiga: current/pending/previous, adição, batch, remoção, reordenação, Next/Previous e avanço após EOF validado. É Main-side e não possui a fila/histórico Controller, mas suas regras não são equivalentes à V1.
- `src/player-control-renderer.ts`, `src/player-control.html`, `src/player-control.css` e `src/player-ui-contracts.ts` pertencem ao shell legado com áreas Controle, Reprodutor e Configurações. `player-control-preload.ts` expõe as operações desse shell.
- Entrada em lote, botões Previous/Stop, reorder/clear, menu, modal, telas separadas e configuração visual descrevem a implementação existente. Não devem ser transplantados para a V1 sem constarem na especificação.
- `src/player-playback.html` e `src/player-playback-renderer.ts` compõem o host técnico Chromium, distinto do shell visual.

### Funcionalidades V1 ainda ausentes ou com semântica diferente

- A UI atual não implementa os atalhos V1 para dígitos, `P`, Espaço, `Ctrl + →`, `R`, Backspace e Esc contextual; também não é uma tela única.
- A sequência atual adiciona faixas pendentes no fim. Não há prioridade LIFO: cada nova prioridade deve ficar à frente das anteriores.
- O `next()` atual, sem item pendente, retorna uma condição de borda e deixa a tentativa atual ativa. A V1 exige encerrar/remover a atual e voltar a ocioso quando não existe próxima música.
- Previous, reorder, clear, remoção de itens e outras operações da sequência antiga não aparecem na V1. Não expô-las no novo Standalone por conveniência.
- A fila V1 e seus comandos precisam ter uma única autoridade no Main. Eventos e ACK do host devem continuar correlacionados por tentativa; a identidade de tentativa de mídia não substitui um ID de intenção/comando quando uma operação for deduplicável.

### Domínio Controller preservado para Combined

- `src/application.ts` contém `KaraokeApplication` e as operações da fila/sessão; `src/state-repository.ts` coordena persistência e recuperação; `src/app-state-validation.ts` valida estado; `database.ts` e `main.ts` são proprietários da fronteira SQLite/IPC.
- `src/queue-rules.ts`, `src/round-robin-rules.ts`, `src/debut-cadence-rules.ts`, `src/fixed-turn-rules.ts`, `src/frozen-queue-rules.ts` e `src/history-rules.ts` mantêm regras de mesa, ordenação, proteção e histórico.
- `src/app.ts`, `src/index.html`, `src/style.css` e `src/ui/` compõem a UI operacional atual. Essas capacidades e dados passam ao Combined; não são alvo de remoção ou refatoração nesta A1/A2.

### Acoplamentos e riscos observados

- `main.ts` é o compositor atual e ramifica startup, IPC, bancos e janelas usando `OperatingModeCapabilities`. Há modo `controller`, `player` e `combined` em `src/operating-mode.ts`; a escolha persistida fica em `operating-mode.json`.
- Em Player, Main cria biblioteca, protocolo, playback, sequência, recovery e catálogo isolado, sem abrir `karaoke.sqlite`. Em Combined, cria serviços Controller e serviços técnicos de Player sobre a única conexão operacional, mas não cria o host/janela visual Player da implementação atual.
- `src/player-control-preload.ts` e `src/player-ui-contracts.ts` estão ligados à UI antiga. A nova interface precisará de contratos próprios ou de uma superfície mínima comprovadamente compartilhável; não se deve expor bridge genérica.
- `KaraokeApplication` e `StateRepository` vivem hoje no Renderer Controller, enquanto SQLite e IPC ficam no Main. Combined deve preservar um único estado operacional confirmado e não criar uma segunda instância de fila/writer para o Standalone.
- `main.ts::runPlayerOperation()` conta operações em curso; não fornece uma serialização global para todos os comandos. A ordem depende das filas/guards específicos dos serviços. A2 não deve documentar garantias que o wrapper IPC não oferece.
- A fila Standalone não deve ser conectada ao banco/fila/histórico Controller. A política de durabilidade da fila não está definida na V1; não inventar persistência nem prometer durabilidade antes de esclarecimento/aprovação.

## Fases

### Fase A — Preparação arquitetural

#### A1 — Checkpoint, documentação e auditoria arquitetural — concluída neste checkpoint

- Ler AGENTS, documentação e configuração de modos; inspecionar o working tree pré-existente.
- Registrar a direção Standalone/Combined no `AGENTS.md` e avisos curtos nos documentos que descrevem o Player legado.
- Auditar infraestrutura compartilhável, UI legado, domínio Controller e acoplamentos.
- Criar este roadmap e preservar a especificação V1 sem alterações.
- Criar um checkpoint Git local. Ele preserva a implementação 5F-B3/B4/B5, mas não substitui a validação audiovisual manual pendente.

#### A2 — Preparar isolamento e contratos — próxima subetapa, não iniciada

**Objetivo:** preparar fronteiras de modo para a base não visual do Standalone sem mudar UI, seleção de modo, comportamento legado, Combined ou rede.

**Escopo proposto:**

1. Definir propriedade e contratos tipados mínimos para estado Standalone, entrada numérica, fila normal/prioritária, comandos, erros e notificações, usando exclusivamente ações da V1.
2. Manter uma só autoridade da sequência no Main. Avaliar o limite entre o `ManualPlaybackService` legado e uma orquestração Standalone separada; não compartilhar suas regras por coincidência de tipos.
3. Reutilizar `PlayerPlaybackService` através de contrato estreito de playback, sem duplicar engine, host, biblioteca ou recovery. Definir como eventos EOF antigos/duplicados e falhas incertas são rejeitados.
4. Delimitar uma superfície IPC/preload própria e mínima para Standalone quando necessária. O buffer numérico, Backspace e estado de navegação menu/painel permanecem interação local; enviar ao Main somente submissões operacionais validadas (código, ação Enter/P e operation ID) e comandos de playback. Não passar caminhos de arquivos, SQL, estado Controller completo ou APIs Node ao Renderer.
5. Definir idempotência por intenção: reentrega da mesma invocação após resposta perdida mantém o mesmo operation/request ID e não duplica a adição; uma nova confirmação intencional, inclusive o mesmo código, é nova posição. Detectar reutilização de ID com payload diferente e definir retenção/escopo da deduplicação. `attemptId` identifica tentativa de mídia, não operação do operador/rede.
6. Definir o ponto de linearização entre prioridade P e EOF: uma prioridade admitida antes da reserva Main-side do próximo item após EOF ocupa o head; depois da reserva/início fica atrás da faixa já iniciada. A fila não pode depender de timing incidental de awaits ou Renderer.
7. Definir `Ctrl + →` como uma operação Main-side: Stop confirmado seguido da próxima faixa pendente, sem fabricar EOF; manter a faixa pendente até um resultado/observação correlacionado confirmar que a nova tentativa começou. Mero ACK de aceitação ou carregamento não basta. Falha incerta exige reconciliação e não permite pular/repetir cegamente. Sem item pendente, parar/limpar a atual e retornar a ocioso.
8. Definir que snapshot publicado reflete decisão de sequência e resultado de playback correlacionados e confirmados pelo serviço. Isso não torna durável a fila; estado de playback `uncertain` bloqueia comandos incompatíveis até reconciliação.
9. Registrar a fronteira Combined: fila e estado operacional permanecem sob autoridade `KaraokeApplication`/`StateRepository`; a sequência Standalone não os altera.
10. Preservar os módulos/testes antigos em seus arquivos atuais enquanto uma implementação nova é preparada em módulos isolados. Evitar extrações amplas ou renomeações cosméticas.

**Arquivos provavelmente afetados:** novos contratos/serviço Standalone sob `src/`; possivelmente `src/player-playback-contracts.ts`, `main.ts` e Preload apenas para fronteiras aprovadas; novos testes focados sob `tests/`. `src/player-control-renderer.ts`, HTML/CSS antigos, modos, `src/application.ts`, regras Controller e SQLite não devem ser alterados sem dependência concreta aprovada.

**Contratos a preparar — não implementados na A1:**

- Snapshot mínimo Standalone: estado operacional V1, faixa atual e fila pendente ordenada, sem dados Controller; publicar após a decisão Main-side e o resultado de playback correlacionados. O snapshot não promete durabilidade da fila.
- Entrada: buffer numérico local no Renderer; Enter/P envia uma submissão completa com ID de operação. Nova ação intencional é distinta; retry IPC da mesma ação reusa ID e payload. Dígitos, Backspace e navegação de menu não precisam de um IPC operacional por tecla.
- Comandos operacionais V1: adicionar normal, priorizar, pausar/continuar, próximo e reiniciar; não acrescentar Previous ou ações fora da V1. Backspace e abrir/fechar menu são estado/interação local de UI, não comandos Main.
- Playback: porta estreita para iniciar/parar/observar uma tentativa com `attemptId`; distinguir Stop confirmado, falha e resultado incerto. Não produzir EOF sintético, e não autorizar Renderer a executar a fila.
- Concorrência: definir reserva/linearização de faixa contra EOF e P, deduplicação por ID/payload, bloqueio após resultado incerto e reconciliação antes de aceitar mutação incompatível.

**Testes A2/B focados:** unitários puros dos novos contratos/regras; testes de serviço para FIFO, duas prioridades consecutivas em ordem LIFO, estados ocioso/reproduzindo/pausado, código inválido/vídeo indisponível, Next com e sem pendência, EOF com/sem próximo item, EOF atual/antigo/duplicado, prioridade concorrente com reserva por EOF, retry com mesmo ID versus nova intenção e ACK incerto. Testar que Stop/Next não fabrica EOF nem descarta head antes do início confirmado. Usar `tests/manual-playback.test.ts` e `tests/player-playback.test.ts` como referências e preservá-los. Teste de fronteira Main/Preload se IPC mudar. E2Es Controller/Windows só entram se a composição, IPC ou comportamento compartilhado for alterado. Não executar a matriz completa por padrão.

**Aceite A2:** contratos documentados e tipados; estado/fila sob autoridade única; nenhuma dependência Standalone de fila ou SQLite Controller; nenhum layout/placeholder implementado; o comportamento legado continua intacto; testes focados determinísticos passam; limites de concorrência e falha ficam explícitos.

### Fase B — Base funcional Standalone

Subetapas sujeitas ao resultado da A2; usar a especificação V1 sem acrescentar comandos:

- **B1:** estados ocioso/reproduzindo/pausado e fila normal/prioritária, incluindo regra LIFO.
- **B2:** intérprete de teclado e entrada numérica; proteger composição de texto, repetição de tecla e foco/contexto do menu conforme contrato aprovado.
- **B3:** integrar comandos com playback compartilhado, EOF natural e avanço manual seguro. Evitar EOF artificial, avanço duplicado e efeitos de tentativa antiga.
- **B4:** integração técnica Main/Preload e testes da base funcional sem UI definitiva. Preservar o Player antigo em paralelo.

### Fase C — Interface Standalone

- Aguardar frames Doop aprovados para a tela única, painel numérico, menus e estados V1.
- Implementar UI própria e integrar atalhos/estado sem reutilizar visual legado incompatível.
- Comparar capturas do Electron real com o Doop, validar acessibilidade e executar E2Es da interface afetada.

### Fase D — Validação e limpeza controlada

- Executar testes focados e integração com os serviços compartilhados afetados em Linux e Windows apropriados.
- Fazer validação audiovisual e comparação visual manual no Windows; obter aprovação explícita do proprietário.
- Só depois classificar cada arquivo como UI antiga, regra obsoleta, teste exclusivo ou serviço reutilizável.
- Remover código/testes apenas quando sua obsolescência e ausência de consumidores forem comprovadas; repetir regressões afetadas.

### Fase E — Atualização dos modos

- Atualizar boas-vindas, onboarding e Configurações para oferecer somente Standalone e Combined.
- Migrar instalações com `controller` persistido sem sobrescrever ou perder `userData`, SQLite, sessões, fila, catálogo ou preferências.
- Preservar o modo legado durante rollout/recuperação até critérios de compatibilidade e rollback serem aprovados.
- Testar perfil novo, perfis antigos, troca/restart, banco e recuperação antes de remover suporte de leitura ao modo Controlador.

### Fase F — Integração remota segura (prioridade de produto após o Standalone)

- Fazer planejamento próprio antes da implementação, incluindo HTTPS/WSS, identidade e autenticação, consentimento/pareamento, validação de certificados, contratos e versionamento.
- Definir autoridade Combined sobre fila/comandos, IDs de item/apresentação, IDs de comando idempotente, `attemptId` do Player, deduplicação, eventos, snapshots, reconexão, timeouts e reconciliação de resultado incerto.
- Definir limites de acesso, revogação, logs, proteção de credenciais, limites de payload/requests, rede local e modelo de falha.
- Testar duplicatas, ACK perdido, ordem fora de sequência, desconexão/reconexão, processos reiniciados e isolamento entre perfis/máquinas.
- O Standalone independente continua funcionando sem rede e não muda seu contrato implicitamente.

### Fase G — Consolidação do Combined

- Integrar as funcionalidades Controller ao modo Combined e conectar a autoridade da fila ao Player local/remoto sem duplicar `KaraokeApplication` ou persistência.
- Implementar reprodução local e, após a Fase F, reprodução remota conforme contratos aprovados.
- Projetar e implementar interfaces/fluxos Combined somente com Doop aprovado.
- Validar operação com um computador, tela estendida/Player destacável, sessão remota, recuperação e regressões dos dados operacionais.

## Regras de avanço

- A ordem de aprovação é A1 → A2 → B → C → D → E → F → G. Preparação documental/arquitetural independente pode ocorrer em paralelo, sem antecipar implementação de fase futura.
- Não iniciar a subetapa seguinte automaticamente; exigir autorização e cumprir seus critérios de entrada.
- Toda subetapa deve registrar escopo, arquivos, testes executados/omitidos, riscos, documentação e critério de conclusão.
- Nenhuma fase remove a especificação V1, o histórico técnico ou serviços/testes legados antes da aprovação de migração correspondente.
