import { Module } from '@nestjs/common';
import { IngestProcessor } from './processor.service';
import { IngestSplitter } from './splitter.service';

@Module({
  providers: [IngestProcessor, IngestSplitter],
  exports: [IngestProcessor, IngestSplitter],
})
export class IngestModule {}
