import { DynamicModule, Inject, Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { CoreModule, CoreOptions } from './core.module';
import { GatewayStateService } from './gateway-state/gateway-state.service';
import { WorkerGauges } from './metrics/gauges';
import { OpsServer } from './metrics/ops-server';
import { QueueService } from './queue/queue.service';
import { CircuitBreakerService } from './worker/circuit-breaker';
import { DeliveryWorker } from './worker/delivery.worker';
import { ProvidersRegistry } from './worker/providers.registry';
import { RetentionService } from './worker/retention.service';

/** Keeps the BullMQ queue's paused flag consistent with the authoritative DB state on startup. */
@Injectable()
class QueueStateSync implements OnApplicationBootstrap {
  constructor(
    @Inject(GatewayStateService) private readonly gateway: GatewayStateService,
    @Inject(QueueService) private readonly queues: QueueService,
  ) {}
  async onApplicationBootstrap() {
    const s = await this.gateway.refreshCache();
    if (s.paused) await this.queues.delivery.pause();
    else if (await this.queues.delivery.isPaused()) await this.queues.delivery.resume();
  }
}

@Module({})
export class WorkerModule {
  static forRoot(opts: CoreOptions & { opsServer?: boolean; retention?: boolean }): DynamicModule {
    return {
      module: WorkerModule,
      imports: [CoreModule.forRoot(opts)],
      providers: [
        QueueStateSync,
        ProvidersRegistry,
        CircuitBreakerService,
        DeliveryWorker,
        ...(opts.retention === false ? [] : [RetentionService]),
        ...(opts.opsServer === false ? [] : [OpsServer, WorkerGauges]),
      ],
      exports: [ProvidersRegistry, DeliveryWorker, CircuitBreakerService],
    };
  }
}
