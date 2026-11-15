import { Controller, Get } from '@nestjs/common';
import { sponsorService } from '../sponsors/sponsor.service.js';

@Controller('api/sponsors')
export class SponsorsController {
  @Get()
  async list() {
    const { sponsors, updatedAt } = await sponsorService.get();
    return { ok: true, sponsors, updatedAt };
  }
}
