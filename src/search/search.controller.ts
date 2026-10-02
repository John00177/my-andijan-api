import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search-query.dto';
import { Public } from '../authz/authz.decorators';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Public()
  @Get()
  search(@Query() query: SearchQueryDto) {
    return this.searchService.search(query);
  }
}
