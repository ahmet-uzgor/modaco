import { Module } from '@nestjs/common';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { IngestProcessor } from './processor.service';
import { IngestSplitter } from './splitter.service';

@Module({
  controllers: [IngestController],
  providers: [IngestProcessor, IngestSplitter, IngestService],
  exports: [IngestProcessor, IngestSplitter, IngestService],
})
export class IngestModule {}
