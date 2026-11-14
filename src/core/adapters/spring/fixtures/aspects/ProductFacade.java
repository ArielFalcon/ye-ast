package app;

public class ProductFacade {
  private final ProductService service;

  public ProductFacade(ProductService service) {
    this.service = service;
  }

  public void create(String name) {
    service.create(name);
  }
}
