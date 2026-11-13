package app;
import java.util.List;
import lombok.Builder;
import lombok.Singular;
@Builder
public class Singles {
  @Singular private List<String> items;
}
