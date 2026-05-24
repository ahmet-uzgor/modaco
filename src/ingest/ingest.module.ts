import { Module } from '@nestjs/common';
import { IngestProcessor } from './processor.service';

@Module({
  providers: [IngestProcessor],
  exports: [IngestProcessor],
})
export class IngestModule {}
