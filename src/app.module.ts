import { PlaywrightModule, PlaywrightService } from '@daechanjo/playwright';
import { RabbitMQModule } from '@daechanjo/rabbitmq';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from '@nestjs-modules/ioredis';
import { Queue } from 'bull';

import { CoupangMessageController } from './api/coupang.message.controller';
import { TypeormConfig } from './config/typeorm.config';
import { CoupangApiService } from './core/coupang.api.service';
import { MessageQueueProcessor } from './core/coupang.queue.processor';
import { CoupangService } from './core/coupang.service';
import { CoupangSignatureService } from './core/coupang.signature.service';
import { CoupangCrawlerService } from './core/crawler/coupang.crawler.service';
import { CrawlCoupangDetailProductsProvider } from './core/crawler/provider/crawlCoupangDetailProducts.provider';
import { CrawlCoupangPriceComparisonProvider } from './core/crawler/provider/crawlCoupangPriceComparison.provider';
import { DeleteConfirmedCoupangProductProvider } from './core/crawler/provider/deleteConfirmedCoupangProduct.provider';
import { InvoiceUploaderProvider } from './core/crawler/provider/invoiceUploader.provider';
import { OrderStatusUpdateProvider } from './core/crawler/provider/orderStatusUpdate.provider';
import { CoupangComparisonEntity } from './infrastructure/entities/coupangComparison.entity';
import { CoupangProductEntity } from './infrastructure/entities/coupangProduct.entity';
import { CoupangUpdateItemEntity } from './infrastructure/entities/coupangUpdateItem.entity';
import { CoupangRepository } from './infrastructure/repository/coupang.repository';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath:
        process.env.NODE_ENV !== 'PROD'
          ? '/Users/daechanjo/codes/project/auto-store/.env'
          : '/app/.env',
    }),
    TypeOrmModule.forRootAsync(TypeormConfig),
    TypeOrmModule.forFeature([
      CoupangProductEntity,
      CoupangUpdateItemEntity,
      CoupangComparisonEntity,
    ]),
    BullModule.registerQueueAsync({
      name: 'coupang-message-queue',
      useFactory: async (configService: ConfigService) => ({
        redis: configService.get<string>('REDIS_URL'),
        prefix: '{bull}',
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 3,
          backoff: 30000,
        },
        limiter: {
          max: 1,
          duration: 1000,
        },
      }),
      inject: [ConfigService],
    }),
    RabbitMQModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        urls: [configService.get<string>('RABBITMQ_URL')],
      }),
    }),
    ConfigModule,
    RedisModule,
    PlaywrightModule,
  ],
  controllers: [CoupangMessageController],
  providers: [
    CoupangSignatureService,
    CoupangService,
    CoupangApiService,
    CoupangCrawlerService,
    MessageQueueProcessor,
    CoupangRepository,
    OrderStatusUpdateProvider,
    InvoiceUploaderProvider,
    DeleteConfirmedCoupangProductProvider,
    CrawlCoupangDetailProductsProvider,
    CrawlCoupangPriceComparisonProvider,
  ],
})
export class AppModule implements OnApplicationBootstrap, OnModuleInit {
  constructor(
    @InjectQueue('coupang-message-queue') private readonly queue: Queue,
    private readonly configService: ConfigService,
    private readonly playwrightService: PlaywrightService,
    private readonly coupangApiService: CoupangApiService,
    private readonly coupangCrawlerService: CoupangCrawlerService,
  ) {}

  async onApplicationBootstrap() {
    setTimeout(async () => {
      this.playwrightService.setConfig(this.configService.get<boolean>('HEAD_LESS'), 'chromium');
      await this.playwrightService.initializeBrowser();
      // await this.coupangCrawlerService.newGetCoupangOrderList('test', 'test');
      // await this.coupangApiService.getProductInflow();
    });
  }

  async onModuleInit() {
    await this.queue.clean(0, 'delayed'); // 지연된 작업 제거
    await this.queue.clean(0, 'wait'); // 대기 중인 작업 제거
    await this.queue.clean(0, 'active'); // 활성 작업 제거
    await this.queue.empty(); // 모든 대기 중인 작업 제거 (옵션)
    console.log('Bull 대기열 초기화');
  }
}
