package app;
import jakarta.validation.ConstraintValidator;
class Validator implements ConstraintValidator<Object, Object> {
  public boolean isValid(Object value, Object context) { return true; }
}
class Factory {
  Object make() {
    return new ConstraintValidator<>() {
      public boolean isValid(Object value, Object context) { return true; }
    };
  }
}
