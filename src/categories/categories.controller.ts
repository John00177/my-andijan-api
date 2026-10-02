import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CategoriesService } from './categories.service';
import { Public } from '../authz/authz.decorators';

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  // Must be declared before ':slug' so "homepage" isn't swallowed as a slug.
  @Public()
  @Get('homepage')
  findHomepage() {
    return this.categoriesService.findHomepage();
  }

  @Public()
  @Get()
  findTree() {
    return this.categoriesService.findTree();
  }

  @Public()
  @Get(':slug')
  findBySlug(@Param('slug') slug: string) {
    return this.categoriesService.findBySlug(slug);
  }
}
