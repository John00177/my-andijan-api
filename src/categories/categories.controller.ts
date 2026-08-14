import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CategoriesService } from './categories.service';

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  // Must be declared before ':slug' so "homepage" isn't swallowed as a slug.
  @Get('homepage')
  findHomepage() {
    return this.categoriesService.findHomepage();
  }

  @Get()
  findTree() {
    return this.categoriesService.findTree();
  }

  @Get(':slug')
  findBySlug(@Param('slug') slug: string) {
    return this.categoriesService.findBySlug(slug);
  }
}
