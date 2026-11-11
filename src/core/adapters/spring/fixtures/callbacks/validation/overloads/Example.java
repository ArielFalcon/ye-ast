package app;
import jakarta.validation.ConstraintValidator;
class Validator implements ConstraintValidator<Object,Object> {
  public boolean isValid(String v, Object c) { return true; }
  public boolean isValid(Integer v, Object c) { return true; }
}
