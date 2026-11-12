# Interfaces do modo pareado — inventário e handoff

## Estado e fontes

Planejamento e criação autorizados em 2026-11-11. Foram consultados os dois canvas, HTML editável e descrições locais originais em `/home/chris/projetos/Contexto Player pareado e Controller Pareado`. Pastas reais: `Modo Controller - pareado` e `Modo Player  - Pareado` (dois espaços antes do hífen no Player). São 13 originais `ready_for_dev` aprovados por Chris; nenhum original foi editado.

Novos frames são **draft**, não aprovação humana. O proprietário autorizou criar telas faltantes e informou que poderá editá-las depois com um agente. Os novos layouts seguem os tokens, sidebar/fila e palco/rodapé já existentes. Textos, inputs e botões são HTML/CSS editáveis; imagens de palco/vídeo foram reutilizadas como fundo ilustrativo, não como rasterização de modal. Não há limitação conhecida do MCP para criar/editar essas interfaces. Não foi implementado comportamento funcional de produção ou protótipo navegável; acessibilidade comportamental será validada em Electron.

Canvas: [Controller — Pareado](http://localhost:4300/c/IY_IYI21QW), [Player — Pareado](http://localhost:4300/c/wsQwJ7ry4g). [Contrato](paired-mode-contract.md), [execução/testes](paired-mode-execution-plan.md).

## Originais aprovados reutilizados

| Canvas | Frame | ID | Reutilização |
|---|---|---|---|
| Controller | Fila Atual — Pareado | 5booCMOuTE | Base da fila/vez, comandos e metadados opcionais |
| Controller | Opções extras da música | oNE_AaxQym | Entrada para Trocar música atual |
| Controller | Opções extras do turno | 6yW_kHriT1 | Menu administrativo; D4 resolvida: promoção automática após EOF/Avançar da última; Stop All é exceção |
| Player | Conectado — Ocioso | KagjaYNZTB | Espera por próxima vez sem duração fixa; não duplicar tela |
| Player | Ocioso — Reconectando | -cYIWa7IlC | Estado real de link |
| Player | Ocioso — Conexão estabelecida | FKBFkDoBFM | Toast de vínculo/link, não de controle concedido |
| Player | Ocioso — Conexão restabelecida | V8JvnGlZ1D | Toast não reassume pareado automaticamente |
| Player | Desconectado — Ocioso — Controle manual | LZhLxxiEgE | Somente **após** confirmação explícita offline; nunca por queda simples |
| Player | Reproduzindo — Conexão estabelecida | pZYyL3yDQI | Vídeo/fundo para referências de controles locais |
| Player | Reproduzindo — Reconectando | ZyDfIbwCB8 | Sem parar vídeo |
| Player | Reproduzindo — Conexão restabelecida | VJTmwS0mZn | Link restaurado, reconciliação separada |
| Player | Reproduzindo — Falha de reconexão | 5xay1Jhkka | Aviso sem interromper vez aceita |
| Player | Conectado — Carregando música | hGwNy76Arh | Loading confirmado; comandos normais bloqueados |

Conflitos de referência registrados sem alterar originais: LZhLxxiEgE descrevia controle manual disponível após falha; agora exige confirmação offline. D4 foi resolvida pelo proprietário; a descrição do menu 6yW_kHriT1 não substitui promoção automática nem autoriza interromper uma vez ativa. Campos de “nenhuma música na fila”/“aguardando música” nos originais não autorizam fila Gestão replicada. Priorizar a nova semântica e revisar variantes antes de implementação.

## Novos frames

Organização horizontal: Controller parte de x=3600, y=15, passo 1560, tamanho 1440×920; Player de x=8270, y=29, passo 1400, tamanho 1280×800. Separação mínima 120 px; nenhum original foi movido. Todos tiveram screenshot MCP inspecionada; revisões corrigiram apresentação/rodapé, EOF anterior em Stop All e espera desconectada como região informativa.

| Canvas | Nome | ID / link | Backlog |
|---|---|---|---|
| Controller | Controller — Confirmar Avançar — Música 1 | [Iul1JD9PBw](http://localhost:4300/c/IY_IYI21QW?frame=Iul1JD9PBw) | H2/H4 |
| Controller | Controller — Confirmar Avançar — Última Música | [vihFyZq4qI](http://localhost:4300/c/IY_IYI21QW?frame=vihFyZq4qI) | H2/H4 |
| Controller | Controller — Confirmar Recomeçar | [N6Oj_XP92O](http://localhost:4300/c/IY_IYI21QW?frame=N6Oj_XP92O) | H2/H4 |
| Controller | Controller — Trocar Música | [FOBeMzlUWv](http://localhost:4300/c/IY_IYI21QW?frame=FOBeMzlUWv) | H2/H4 |
| Controller | Controller — Erro de envio de comando | [Y47usa8PN0](http://localhost:4300/c/IY_IYI21QW?frame=Y47usa8PN0) | G5/H4 |
| Controller | Controller — Comando com confirmação incerta | [kKJpUsOjMV](http://localhost:4300/c/IY_IYI21QW?frame=kKJpUsOjMV) | G4/G5/H4 |
| Controller | Controller — Erro de disponibilidade | [9VZvnRMUbQ](http://localhost:4300/c/IY_IYI21QW?frame=9VZvnRMUbQ) | H1/H4 |
| Controller | Controller — Assumir Player local | [NZdmSCHivT](http://localhost:4300/c/IY_IYI21QW?frame=NZdmSCHivT) | H3/H4 |
| Controller | Controller — Divergência de reconciliação | [yDsRajh7GQ](http://localhost:4300/c/IY_IYI21QW?frame=yDsRajh7GQ) | H3/H4 |
| Controller | Controller — Retornar ao modo pareado | [eghthO89ZV](http://localhost:4300/c/IY_IYI21QW?frame=eghthO89ZV) | H3/H4 |
| Player | Player — Apresentação da Próxima Vez | [3a9l_r00eg](http://localhost:4300/c/wsQwJ7ry4g?frame=3a9l_r00eg) | H2/H4 |
| Player | Player — Confirmar Avançar — Música 1 | [RVRxz-s16i](http://localhost:4300/c/wsQwJ7ry4g?frame=RVRxz-s16i) | H2/H4 |
| Player | Player — Confirmar Avançar — Última Música | [2NjukUsCvh](http://localhost:4300/c/wsQwJ7ry4g?frame=2NjukUsCvh) | H2/H4 |
| Player | Player — Confirmar Recomeçar — Pareado | [ybFFiZIeQq](http://localhost:4300/c/wsQwJ7ry4g?frame=ybFFiZIeQq) | H2/H4 |
| Player | Player — Confirmar Parar Tudo — Pareado | [GxtqFzuqvy](http://localhost:4300/c/wsQwJ7ry4g?frame=GxtqFzuqvy) | H2/H4 |
| Player | Player — Confirmar transição para offline | [TuUROWWoPv](http://localhost:4300/c/wsQwJ7ry4g?frame=TuUROWWoPv) | H3/H4 |
| Player | Player — Erro de mídia e recuperação | [KSeuQePHvO](http://localhost:4300/c/wsQwJ7ry4g?frame=KSeuQePHvO) | H2/H4 |
| Player | Player — Espera após perda de conexão | [kEiJdRV0oQ](http://localhost:4300/c/wsQwJ7ry4g?frame=kEiJdRV0oQ) | G5/H3/H4 |

## Descrições por frame

### Controller — Confirmar Avançar — Música 1

- Canvas: IY_IYI21QW; frame: `Iul1JD9PBw`; estado: draft; dimensão: 1440×920.
- Objetivo/estado: Cancelar a primeira música?; contexto ilustrativo: 1001 · Always — Ana Luiza, Mesa 2.
- Texto principal: “A música atual não será marcada como cantada. A segunda música começará automaticamente. Se o código estiver errado, você pode trocar a música.”.
- Abertura: Operador aciona Avançar na música 1 de vez com duas músicas, playing/paused.
- Ações: Confirmar cancela somente a ocorrência/alvo capturado e inicia a segunda após contenção/registro; Trocar música na Gestão abre o fluxo de troca, sem executar Avançar.
- Rótulos: Cancelar música e avançar / Trocar música / Cancelar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H2/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Controller — Confirmar Avançar — Última Música

- Canvas: IY_IYI21QW; frame: `vihFyZq4qI`; estado: draft; dimensão: 1440×920.
- Objetivo/estado: Encerrar esta vez?; contexto ilustrativo: 1002 · Música 2 — Ana Luiza, Mesa 2.
- Texto principal: “A última música será cancelada e não será marcada como cantada. A vez será encerrada sem celebração. A Gestão poderá determinar a próxima vez.”.
- Abertura: Operador aciona Avançar na última música, playing/paused.
- Ações: Confirmar cancela somente o alvo, encerra a vez sem celebração e informa a Gestão; não marca cantada.
- Rótulos: Cancelar música e encerrar / Cancelar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H2/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Controller — Confirmar Recomeçar

- Canvas: IY_IYI21QW; frame: `N6Oj_XP92O`; estado: draft; dimensão: 1440×920.
- Objetivo/estado: Recomeçar a música?; contexto ilustrativo: 1002 · Música atual — Ana Luiza, Mesa 2.
- Texto principal: “A música começará do início. A fila e as músicas já cantadas serão preservadas. Abrir esta confirmação não pausa a reprodução.”.
- Abertura: Operador aciona Recomeçar/Reiniciar, playing/paused.
- Ações: Confirmar reinicia do começo com nova tentativa na mesma ocorrência; fila e cantadas anteriores intactas.
- Rótulos: Recomeçar / Cancelar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H2/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Controller — Trocar Música

- Canvas: IY_IYI21QW; frame: `FOBeMzlUWv`; estado: draft; dimensão: 1440×920.
- Objetivo/estado: Trocar a música atual?; contexto ilustrativo: Ana Luiza · Mesa 2 · Música 2.
- Texto principal: “A nova música será validada antes da troca e começará do início. A troca ficará registrada; não marcará a música anterior como cantada.”.
- Abertura: Menu da música atual ou ação Trocar música do modal Avançar; playing/paused ou erro confirmado em loading.
- Ações: Validar e trocar consulta código, valida mídia e alvo, contém tentativa anterior, registra troca e inicia nova tentativa na mesma ocorrência. Não editar cantada ou música futura.
- Rótulos: Validar e trocar / Cancelar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H2/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Controller — Erro de envio de comando

- Canvas: IY_IYI21QW; frame: `Y47usa8PN0`; estado: draft; dimensão: 1440×920.
- Objetivo/estado: O comando não foi enviado; contexto ilustrativo: Recomeçar · Música 2.
- Texto principal: “Foi confirmado que o comando não saiu da Gestão. A reprodução não foi alterada por esta ação. Você pode tentar enviar a mesma operação novamente.”.
- Abertura: Main comprova que a operação não foi enviada. Não usar este aviso para timeout após envio.
- Ações: Tentar enviar reutiliza operationId e payload da intenção ainda válida. Não produz novo comando Avançar.
- Rótulos: Tentar enviar / Fechar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: G5/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Controller — Comando com confirmação incerta

- Canvas: IY_IYI21QW; frame: `kKJpUsOjMV`; estado: draft; dimensão: 1440×920.
- Objetivo/estado: Resultado ainda não confirmado; contexto ilustrativo: Avançar · Música 2.
- Texto principal: “O Player pode ter executado o comando. Consulte o resultado antes de tentar outra ação. A música pode continuar no Player.”.
- Abertura: Comando enviado sem resultado conclusivo após prazo limitado, incluindo queda/ACK perdido.
- Ações: Consultar resultado consulta operationId original. Fechar aviso conserva operação pendente; nenhuma nova mutação automática.
- Rótulos: Consultar resultado / Fechar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: G4/G5/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Controller — Erro de disponibilidade

- Canvas: IY_IYI21QW; frame: `9VZvnRMUbQ`; estado: draft; dimensão: 1440×920.
- Objetivo/estado: Não foi possível iniciar a vez; contexto ilustrativo: Ana Luiza · Mesa 2.
- Texto principal: “A segunda música, código 1002, está indisponível. Nenhuma música desta vez foi iniciada ou marcada como cantada. Corrija o código ou verifique a biblioteca.”.
- Abertura: Player rejeita a aceitação porque uma das músicas não está disponível; exemplo: música 2.
- Ações: Verificar novamente consulta mídia; Corrigir vez abre correção do pacote ainda não aceito. Não contorna validação nem promove outra pessoa.
- Rótulos: Verificar novamente / Corrigir vez / Fechar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H1/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Controller — Assumir Player local

- Canvas: IY_IYI21QW; frame: `NZdmSCHivT`; estado: draft; dimensão: 1440×920.
- Objetivo/estado: Como assumir o Player?; contexto ilustrativo: Player em reprodução local · código 1001.
- Texto principal: “Aguardar mantém a música local até o fim. Assumir agora cancela a execução local sem marcá-la como cantada. A vez remota só começa após contenção segura.”.
- Abertura: Após reconciliação inicial, Gestão pede controle de Player em modo offline com música local ativa.
- Ações: Aguardar mantém música atual até fim e cerca novas execuções locais; Encerrar local e assumir exige contenção/cancelamento confirmado antes de ativar vez remota. Ao assumir, suspender a fila local, sem importar ou executar automaticamente. D2 parcialmente resolvida: descarte definitivo versus retorno da fila suspensa permanece pendente.
- Rótulos: Aguardar música terminar / Encerrar local e assumir / Cancelar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H3/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Controller — Divergência de reconciliação

- Canvas: IY_IYI21QW; frame: `yDsRajh7GQ`; estado: draft; dimensão: 1440×920.
- Objetivo/estado: É preciso conferir a execução; contexto ilustrativo: A vez recebida diverge do estado da Gestão.
- Texto principal: “A execução atual será preservada. Confira os resultados registrados pelo Player antes de liberar novas operações. O histórico não será sobrescrito.”.
- Abertura: Snapshot/eventos/operações divergem sem resolução automática segura.
- Ações: Consultar resultados abre inspeção contextual das evidências; nenhuma escolha destrutiva ou sobrescrita implícita. Decisão operacional depende do conflito concreto, não de um botão genérico de forçar.
- Rótulos: Consultar resultados / Fechar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H3/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Controller — Retornar ao modo pareado

- Canvas: IY_IYI21QW; frame: `eghthO89ZV`; estado: draft; dimensão: 1440×920.
- Objetivo/estado: Retomar o controle remoto?; contexto ilustrativo: Conexão disponível · Player em modo offline.
- Texto principal: “Primeiro serão conciliados os resultados locais e as operações pendentes. A fila local não será importada. Se houver música local ativa, você escolherá como assumir.”.
- Abertura: Conexão autenticada disponível com Player em modo offline, após pedido explícito da Gestão.
- Ações: Conciliar e continuar inicia conciliação, sem ativação automática. Se música local ativa, abrir takeover; se houver pendências locais, suspendê-las sem importar/executar automaticamente; não decidir descarte definitivo ou retorno, ainda pendentes em D2.
- Rótulos: Conciliar e continuar / Cancelar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H3/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Player — Apresentação da Próxima Vez

- Canvas: wsQwJ7ry4g; frame: `3a9l_r00eg`; estado: draft; dimensão: 1280×800.
- Objetivo/estado: Sua vez de cantar; contexto ilustrativo: Ana Luiza · Mesa 2.
- Texto principal: “1001 · Always — Bon Jovi|1002 · Metadados indisponíveis”.
- Abertura: Vez aceita com ambas as músicas validadas e celebração anterior encerrada, ou primeira vez após idle.
- Ações: Sem botões. Contagem Main de 5 s substitui countdown; ao final revalidar mídia e iniciar primeira. Sem edição/avanço/playback nesta janela. Queda após aceite mantém sequência.
- Rótulos: nenhum controle; contador ilustrativo 5.
- Fechamento: ao concluir os 5 s no Main, sem segunda contagem; timer não é executado pelo frame estático.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: sem foco capturado nem botões de comando; anúncios acessíveis do estado/tempo sem repetição excessiva.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H2/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Player — Confirmar Avançar — Música 1

- Canvas: wsQwJ7ry4g; frame: `RVRxz-s16i`; estado: draft; dimensão: 1280×800.
- Objetivo/estado: Cancelar a primeira música?; contexto ilustrativo: 1001 · Always — Ana Luiza, Mesa 2.
- Texto principal: “Ela não será marcada como cantada. A segunda música começará automaticamente. Para corrigir o código, use Trocar música na Gestão.”.
- Abertura: Operador aciona Avançar na música 1 de vez com duas músicas, playing/paused.
- Ações: Confirmar cancela somente a ocorrência/alvo capturado e inicia a segunda após contenção/registro; Trocar música na Gestão abre o fluxo de troca, sem executar Avançar.
- Rótulos: Cancelar música e avançar / Cancelar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H2/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Player — Confirmar Avançar — Última Música

- Canvas: wsQwJ7ry4g; frame: `2NjukUsCvh`; estado: draft; dimensão: 1280×800.
- Objetivo/estado: Encerrar esta vez?; contexto ilustrativo: 1002 · Música 2 — Ana Luiza, Mesa 2.
- Texto principal: “A música será cancelada e a vez encerrada sem celebração. Ela não será marcada como cantada. Aguarde a próxima vez enviada pela Gestão.”.
- Abertura: Operador aciona Avançar na última música, playing/paused.
- Ações: Confirmar cancela somente o alvo, encerra a vez sem celebração e informa a Gestão; não marca cantada.
- Rótulos: Cancelar música e encerrar / Cancelar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H2/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Player — Confirmar Recomeçar — Pareado

- Canvas: wsQwJ7ry4g; frame: `ybFFiZIeQq`; estado: draft; dimensão: 1280×800.
- Objetivo/estado: Recomeçar a música?; contexto ilustrativo: 1002 · Música atual — Ana Luiza, Mesa 2.
- Texto principal: “A música começará do início. A fila da Gestão e as músicas já cantadas serão preservadas. Esta confirmação não pausa a reprodução.”.
- Abertura: Operador aciona Recomeçar/Reiniciar, playing/paused.
- Ações: Confirmar reinicia do começo com nova tentativa na mesma ocorrência; fila e cantadas anteriores intactas.
- Rótulos: Recomeçar / Cancelar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H2/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Player — Confirmar Parar Tudo — Pareado

- Canvas: wsQwJ7ry4g; frame: `GxtqFzuqvy`; estado: draft; dimensão: 1280×800.
- Objetivo/estado: Parar esta vez?; contexto ilustrativo: Ana Luiza · Mesa 2.
- Texto principal: “A música atual e a segunda música pendente serão canceladas. Os cancelamentos não serão marcados como cantados; EOFs anteriores serão preservados. O Player ficará ocioso; a fila futura da Gestão será preservada e ninguém será promovido automaticamente.”.
- Abertura: Operador aciona Parar Tudo no Player pareado quando permitido pelo runtime.
- Ações: Confirmar cancela atual e segunda pendente, registra terminal e retorna idle; EOFs anteriores preservados; não promove nem limpa fila futura Gestão.
- Rótulos: Parar tudo / Cancelar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H2/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Player — Confirmar transição para offline

- Canvas: wsQwJ7ry4g; frame: `TuUROWWoPv`; estado: draft; dimensão: 1280×800.
- Objetivo/estado: Entrar em modo offline?; contexto ilustrativo: Não foi possível reconectar à Gestão.
- Texto principal: “A entrada local de músicas será habilitada após a transição segura. Resultados confirmados serão preservados. Comandos remotos antigos não serão executados.”.
- Abertura: Falha de reconexão e operador solicita modo offline. Este frame representa idle. D3 resolvida: nunca abrir como autorização para transição durante vez ativa; aguardar conclusão ou Parar Tudo explicitamente confirmado antes de transitar.
- Ações: Confirmar cerca comandos antigos e muda explicitamente modo para habilitar entrada local, preservando resultados. Não é troca da função instalada. Main deve negar a transição se uma vez estiver ativa, inclusive se aceita enquanto a confirmação estava aberta; pedido de offline não aciona Stop All automaticamente.
- Rótulos: Entrar em modo offline / Cancelar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H3/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Player — Erro de mídia e recuperação

- Canvas: wsQwJ7ry4g; frame: `KSeuQePHvO`; estado: draft; dimensão: 1280×800.
- Objetivo/estado: A música não pôde continuar; contexto ilustrativo: 1002 · Música 2 — Ana Luiza, Mesa 2.
- Texto principal: “A vez está preservada. Nenhum erro será registrado como música cantada. Verifique a biblioteca; recuperar exige validação e não inicia música sem confirmação.”.
- Abertura: Erro confirmado da mídia, inclusive loading, ou falha entre músicas; não abrir por simples queda de rede.
- Ações: Validar e recuperar usa recovery Main e revalida alvo/mídia. Nova tentativa somente após confirmação segura; não fabricar EOF. Troca excepcional é oferecida na Gestão pelo frame de troca.
- Rótulos: Validar e recuperar / Fechar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; sucesso confirmado encerra a janela. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab contidos somente nos modais, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: H2/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

### Player — Espera após perda de conexão

- Canvas: wsQwJ7ry4g; frame: `kEiJdRV0oQ`; estado: draft; dimensão: 1280×800.
- Objetivo/estado: Vez encerrada; contexto ilustrativo: Aguardando a Gestão.
- Texto principal: “Os resultados foram preservados. Reconectar não inicia uma nova vez. Aguarde a Gestão ou escolha explicitamente o modo offline.”.
- Abertura: Vez encerrou e conexão continua indisponível; abrir como estado informativo da tela, não modal automático.
- Ações: Tentar reconectar autentica/consulta sem reassumir controle; Entrar offline abre confirmação específica; Fechar remove painel informativo e preserva estado. Não há prazo fixo de espera.
- Rótulos: Tentar reconectar / Entrar em modo offline / Fechar.
- Fechamento: Cancelar/Fechar/Esc não produz mutação; resultado de consulta atualiza o painel. EOF, mudança de alvo, tentativa ou modo invalida confirmação antiga; não reutilizar contra próxima música.
- Erro: manter mensagem contextual e alvo, sem sucesso otimista; timeout após envio vira incerto e consulta usa ID original. Contenção ou persistência falha bloqueia ação dependente; não perde evidência. Para telas informativas, uma consulta falha não libera controle.
- Teclado: foco inicial na ação segura, Tab/Shift+Tab sem aprisionar foco nesta região não modal, Esc cancela/fecha sem mutação, Enter aciona só o controle focado; restaurar foco ao gatilho se ainda existir.
- Playback: abrir modal/aviso nunca pausa música. Todos os efeitos dependem de validação Main; HTML é referência estática, não execução real.
- Backlog: G5/H3/H4; [contrato funcional](paired-mode-contract.md) e [matriz](paired-mode-execution-plan.md).

## Limites e variantes futuras

Os frames mostram exemplos estáticos; não comprovam timers, rede, áudio/vídeo, contenção, persistência ou trap de foco. Modais de operação só abrem quando permitidos e não aparecem automaticamente na apresentação. A região de espera desconectada não é modal; espera conectada reutiliza KagjaYNZTB. Metadados ilustrativos não viram requisito de CSV.

Após T1, desenhar consentimento/revogação/confiança de G2 e seus erros antes do lote visual. Após decisão final D2 e conflitos concretos, completar escolhas de descarte/retorno da fila suspensa; D3 já define que transição ativa é proibida, com espera ou Parar Tudo explícito antes da saída. Completar a informação desses estados e inspeção detalhada de divergência, sem inventar política agora. H4.2 também deve fornecer variantes de troca com consulta em andamento/indisponível/sem CSV e comandos bloqueados para as dimensões suportadas, reaproveitando os componentes criados. Esses complementos visuais não estão declarados criados nesta rodada.

Parecer visual das capturas novas: conteúdo e ações couberam, espaçamento/hierarquia/contraste e alinhamento legíveis nos tamanhos de referência; controles críticos distinguíveis por texto/cor. Não houve comparação com Electron porque nenhuma UI de produção foi implementada. Aprovação manual permanece pendente.

## Atualização descritiva D1–D5

D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida conforme decisão do proprietário. Nenhum frame Doop foi alterado nesta rodada; textos ilustrativos anteriores continuam como referência visual draft e não substituem o contrato vigente. Em especial, “a Gestão poderá determinar a próxima vez” no modal antigo de Avançar última deve ser interpretado pela regra D4: promoção automática pelo Round Robin após cancelamento confirmado. A futura revisão visual deverá explicitar essa regra, o bloqueio de offline ativo e a marca de cadastro offline não verificado. As descrições externas criadas anteriormente não foram sobrescritas; este adendo e o contrato prevalecem até sua sincronização visual autorizada. Aprovação visual continua pendente.

## Inventário futuro — descoberta e pareamento LAN (sem frames criados)

Revisão solicitada pelo proprietário: pareamento normal inteiramente na UI/rede local, sem arquivo, pendrive, QR, IP ou fingerprint. [Complemento T1 LAN](g1-1-t1-lan-pairing.md) é proposta técnica aguardando aprovação; decisões funcionais de autoridade e offline permanecem. Nenhum frame foi criado/modificado nesta rodada e nenhuma descrição externa foi sobrescrita.

Consulta somente leitura aos dois canvas via Doop MCP e às pastas reais `Modo Controller - pareado` / `Modo Player  - Pareado`. Referências relidas: Controller `5booCMOuTE` (1440×920, ready_for_dev), Player `KagjaYNZTB` e `-cYIWa7IlC` (1280×800, ready_for_dev). O HTML Controller contém o sino `data-doop-id="notifications"` dentro de `header`. Esses frames não incluem o novo pareamento; aprovação deles não é aprovação da nova interface.

### Controller — canvas IY_IYI21QW

Referência base `5booCMOuTE`: criar futuramente **nova variante** da barra superior, sem editar original aprovado nesta rodada. Ícone Dispositivos imediatamente **à esquerda do sino**, no mesmo grupo, mantendo o sino e sem reconstruir sidebar/fila. Nome acessível “Dispositivos e conexão”, estado textual acessível e acionamento por teclado; não escolher ícone/cor definitiva sem novo frame autorizado. Painel de dispositivos é aberto por clique/teclado; nenhuma UI fictícia de conexão.

| Frame/variante a criar (ID ainda inexistente) | Objetivo, estado, ações e fechamento | Backlog |
|---|---|---|
| Controller — Dispositivos — Buscando | Ícone abre painel; lista vazia em busca real, indicador discreto, Atualizar coalescido, Fechar; não inventar dispositivos | G5.4 |
| Controller — Dispositivos — Encontrados | Nome amigável escapado, “Encontrado — não verificado”, selecionar Vincular; anúncios não pintam conexão/confiança | G5.4/G2 |
| Controller — Dispositivos — Vínculos salvos | Separar encontrado agora de “Vinculado, não encontrado agora”; Conectado só após auth; reconectando/reconciliando distintos; selecionar/reconectar ou gerenciar vínculo | G5.4/G4 |
| Controller — Dispositivos — Nenhum encontrado | Explicar mesma rede/bloqueio possível, Atualizar, Ajuda e Avançado (endereço opcional); sem obrigar técnico no fluxo normal | G5.4 |
| Controller — Pareamento — Aguardando Player | Pedido enviado, nome ainda não verificado; Cancelar; rejeição/timeout/quota fecham sessão com feedback, não a lista silenciosamente | G5.4/G2 |
| Controller — Pareamento — Digitar código | “Digite o código mostrado no Player”, 8 dígitos agrupados 4–4; Confirmar/Cancelar; nunca apresentar código como bearer/pin | G5.4/G2 |
| Controller — Pareamento — Verificando/Salvando | Provas/binding/persistência em andamento, duração limitada; resultado incerto explícito, não “conectado” otimista; consulta da mesma sessão | G5.4/G2 |
| Controller — Pareamento — Erro/Rejeitado/Expirado | Código incorreto, pedido recusado, timeout, ocupado, tentativas excedidas, confiança inválida e falha de gravação em variantes compreensíveis; Tentar novamente requer nova sessão/consentimento quando apropriado | G5.4/G2 |
| Controller — Renovar vínculo | Avisos 30/7 dias; seleção do Player, instrução para renovar localmente se certificado venceu, mesmo código/consentimento; não há botão de ignorar certificado | G5.4/G2/G4 |
| Controller — Conectado — Player offline | Link autenticado ou conciliado sem assumir operação; retorno explícito usa `eghthO89ZV`/takeover `NZdmSCHivT` conforme contrato, sem pareamento repetido | G5/H4.4 |

Nomes iguais não são identificador técnico confiável: pedir confirmação na tela física desejada. Admissão/erro de código vêm de G2/Main; Renderer não calcula provas, não guarda pin/token nem gera autorização por clique.

### Player — canvas wsQwJ7ry4g

Reutilizar palco/footer de `KagjaYNZTB` e estados `-cYIWa7IlC`/`V8JvnGlZ1D`/`ZyDfIbwCB8`/`5xay1Jhkka` onde corresponderem a eventos reais. Novas confirmações são modais locais críticos; nenhuma pausa playback só por abrir. Se houver vez ativa, não aplicar manutenção do vínculo por efeito colateral; política operacional permanece conforme contrato.

| Frame/variante a criar (ID ainda inexistente) | Objetivo, estado, ações e fechamento | Backlog |
|---|---|---|
| Player — Permitir descoberta nesta rede | Primeiro consentimento simples para aparecer na rede; Permitir/Agora não; seleção por nome de adaptador só se múltiplas redes ambíguas, sem IP obrigatório | G5.4/G1 |
| Player — Pedido de vínculo | Nome informado da Gestão explicitamente não verificado, Permitir/Rejeitar; um pedido por vez, quota e Cancelar/Expirar fecham só a sessão correspondente | G5.4/G2 |
| Player — Código de pareamento | Exibir 8 dígitos 4–4 após permissão; orientar digitar na Gestão, tempo restante de sessão e Cancelar; não anunciar código em mDNS ou log | G5.4/G2 |
| Player — Confirmando vínculo | Provas/persistência, sem sucesso antes do commit; exibir erro/incerteza com recuperação local segura se necessário | G5.4/G2 |
| Player — Vínculo concluído | Confirmação real, código deixa de aparecer; estado conectado/aguardando ou conciliando conforme serviço; nenhum autoplay | G5.4/G4 |
| Player — Vínculo rejeitado/expirado/ocupado/limitado | Mensagem contextual e nova tentativa por consentimento; não trocar o código de sessão já ativa por outro pedido | G5.4/G2 |
| Player — Renovação necessária/expirada | Avisos locais 30/7 dias, Renovar/Depois; certificado vencido exige renovação local consentida antes de novo bootstrap, sem bypass; 365 dias mantidos | G5.4/G2 |
| Player — Remover/substituir Gestão | Confirmação local, gravação de revogação antes do sucesso; falha de disco diz que remoção permanente não foi salva. Não apaga fila/journal ou cria outro Controller | G5.4/G2 |
| Player — Remoto indisponível — Cofre/rede | Explicar recuperação/desbloqueio/multicast/interface de forma simples, local permanece utilizável; não oferecer fallback de segredo em claro | G5.4 |

### Comportamento comum e critérios de handoff

- Cancelar/Esc só cancela a sessão identificada; confirmação tardia não aceita outro peer. Foco inicial seguro e retorno ao gatilho; Tab/Shift+Tab e Enter sem ação destrutiva implícita.
- Nome/endereço/anúncio são dados não confiáveis; tela só exibe como texto. Vínculo salvo, transporte conectado, reconciliação e controle operacional são estados separados.
- Reabrir lista não reinicia PAKE nem revoga vínculo. Após vínculo válido, restart/queda não pedem código; G4 reconecta, preservando Player explicitamente offline.
- Frames e descrições correspondentes só serão criados após autorização. Conteúdo visual, ícone e microcopy acima são planejamento, não aprovação/implementação de interface. Ao implementar, comparar Electron/Doop nas dimensões de referência e testar rede real/IPC/armazenamento e teclado.
- Nenhum novo ID de frame atribuído nesta revisão. Originais e frames já existentes permanecem intactos; o registro anterior de arquivo/QR na T1 foi substituído pela decisão LAN, não por edição dos designs nesta rodada.
