package app;
import lombok.Getter;
import lombok.Setter;
public class FieldOnly {
  @Getter private String shown;
  @Setter private String written;
  private String hidden;
}
